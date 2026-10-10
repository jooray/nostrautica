package today.cypherpunk.nostrautica.domain.dm

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.DmReadPosition
import today.cypherpunk.nostrautica.protocol.DmReadState
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.signer.SignerNeedsUser
import today.cypherpunk.nostrautica.signer.silently

/** The DM service, registered lazily from this file. */
val AppContainer.dms: Dms get() = area("dms") { Dms(nostr, cache, accounts, session, DmMutes(nostr, cache, accounts)) }

/**
 * NIP-17 direct messages (events/dm.ts, events/dm-read-state.ts,
 * stores/dm-unread.svelte.ts), shaped for a phone's battery and data plan.
 *
 * READING. Gift wraps `#p` = me land in the local event store (from this class's
 * scans, the live subscription, and the grants scan, which reads the same inbox).
 * Each wrap is unwrapped at most once: the outcome — the message, or "not a DM of
 * ours" — is memoized per wrap id in the owner cache (capped at 3000), so history
 * paints instantly and offline and nothing is ever decrypted twice. A failed
 * unwrap is not memoized (a flaky signer must not hide a real message for good)
 * but is retried at most [DmLogic.MAX_UNWRAP_ATTEMPTS] times per process.
 *
 * NETWORK. No polling. While Messages or a thread is on screen, [watch] holds ONE
 * live subscription for 1059 `#p`=me from the last cursor and walks unread history
 * in bounded pages (200 × 5 per open). Otherwise the inbox is scanned once when
 * the app comes up or returns to the foreground, at most every [SCAN_TTL_MS].
 *
 * SIGNER. Work the user didn't start runs inside `silently {}`: a local key
 * unwraps as usual, Amber answers only if it can without UI, and a NIP-46 bunker
 * is left alone — so a nav badge never pops a signer. Remote signers unwrap
 * interactively only while the user has Messages open. What is still ciphertext
 * shows as "encrypted activity" instead of a count.
 *
 * SENDING. Two wraps of one rumor (recipient + self copy), each to that party's
 * 10050 inboxes ∪ the defaults. The message is memoized under the self copy's
 * wrap id before anything is published, so it shows at once and, offline, sits in
 * the outbox rendered as queued.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Dms(
    private val nostr: Nostr,
    private val cache: Cache,
    private val accounts: Accounts,
    private val session: Session,
    val mutes: DmMutes,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val memoSer = MapSerializer(String.serializer(), DmMemoEntry.serializer())
    private val wmSer = MapSerializer(String.serializer(), DmReadPosition.serializer())

    // ── Per-owner state ─────────────────────────────────────────────────────
    @Volatile private var owner: String? = null
    private val memo = LinkedHashMap<String, DmMemoEntry>()
    private val attempts = HashMap<String, Int>()
    private val ownerLock = Mutex()
    private val unwrapLock = Mutex()
    private val scanLock = Mutex()

    private val _messages = MutableStateFlow<List<DmMessage>>(emptyList())
    /** Every decrypted message of the signed-in user, oldest first. No network, no signer. */
    val messages: StateFlow<List<DmMessage>> get() = _messages

    private val _watermarks = MutableStateFlow<Watermarks>(emptyMap())
    val watermarks: StateFlow<Watermarks> get() = _watermarks

    private val _loaded = MutableStateFlow(false)
    /** The owner's cached state has been read back (an unknown count is not zero). */
    val loaded: StateFlow<Boolean> get() = _loaded

    private val _activity = MutableStateFlow(DmActivity())

    /** Per-peer unread counts, from cached plaintext + read state. Muted peers don't count. */
    val unreadByPeer: StateFlow<Map<String, Int>> =
        combine(_messages, _watermarks, _loaded, mutes.muted) { msgs, wm, loaded, muted ->
            val me = owner
            if (!loaded || me == null) emptyMap() else DmLogic.unreadByPeer(msgs, me, wm).filterKeys { it !in muted }
        }.stateIn(scope, SharingStarted.Eagerly, emptyMap())

    /** The nav badge: unread direct messages. Cheap — never touches the network or a signer. */
    val unreadCount: StateFlow<Int> = unreadByPeer.map { it.values.sum() }.stateIn(scope, SharingStarted.Eagerly, 0)

    /** Wraps arrived that are still ciphertext (a remote signer that wasn't asked): the badge's dot. */
    val hasEncryptedActivity: StateFlow<Boolean> =
        combine(_activity, _loaded) { a, loaded -> loaded && a.pending.isNotEmpty() }.stateIn(scope, SharingStarted.Eagerly, false)

    /** Wrap ids still waiting in the outbox (sends not yet on any relay), with whether they are parked as failed. */
    val outbox: StateFlow<Map<String, Boolean>> = session.account
        .flatMapLatest { a -> a?.let { nostr.observeOutbox(it.pubkey).map { rows -> rows.associate { r -> r.id to r.failed } } } ?: flowOf(emptyMap()) }
        .stateIn(scope, SharingStarted.Eagerly, emptyMap())

    private val prefills = HashMap<String, String>()

    init {
        scope.launch {
            session.account.collect { a ->
                switchTo(a?.pubkey)
                if (a != null) refreshInBackground()
            }
        }
        // App back on screen: one silent, TTL-gated look at the inbox. Never in the background.
        scope.launch(Dispatchers.Main) {
            androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.addObserver(object : androidx.lifecycle.DefaultLifecycleObserver {
                override fun onStart(owner: androidx.lifecycle.LifecycleOwner) { refreshInBackground() }
                override fun onStop(owner: androidx.lifecycle.LifecycleOwner) { flushReadState() }
            })
        }
    }

    private suspend fun switchTo(pubkey: String?) = ownerLock.withLock {
        if (owner == pubkey && _loaded.value) return@withLock
        // Account switch: nothing of the previous identity survives in memory.
        readDebounce?.cancel(); readDebounce = null
        lastPullAt = 0; lastRemote = null
        synchronized(memo) { memo.clear(); attempts.clear() }
        _loaded.value = false
        owner = pubkey
        _messages.value = emptyList(); _watermarks.value = emptyMap(); _activity.value = DmActivity()
        mutes.setOwner(pubkey)
        if (pubkey == null) return@withLock
        val stored = cache.get(pubkey, MEMO_KEY, memoSer) ?: emptyMap()
        synchronized(memo) { memo.putAll(stored) }
        _watermarks.value = cache.get(pubkey, READ_KEY, wmSer) ?: emptyMap()
        _activity.value = cache.get(pubkey, ACTIVITY_KEY, DmActivity.serializer()) ?: DmActivity()
        publishSnapshot()
        _loaded.value = true
    }

    private fun publishSnapshot() {
        _messages.value = synchronized(memo) { DmLogic.snapshot(memo) }
    }

    private suspend fun persistMemo(me: String) {
        val capped = synchronized(memo) {
            val c = DmLogic.capMemo(memo)
            if (c.size < memo.size) { memo.clear(); memo.putAll(c) }
            HashMap(c)
        }
        cache.put(me, MEMO_KEY, memoSer, capped, nowSec())
    }

    // ── Scanning ────────────────────────────────────────────────────────────

    private suspend fun inboxRelays(me: String): List<String> =
        DmLogic.selectDmRelays(runCatching { accounts.inboxRelays(me) }.getOrDefault(emptyList()))

    private fun inboxFilter(me: String, since: Long? = null, until: Long? = null, limit: Int? = null) =
        Filter(kinds = listOf(Kinds.GIFT_WRAP), tags = mapOf("p" to listOf(me)), since = since, until = until, limit = limit)

    private suspend fun scanState(me: String) = cache.get(me, SCAN_KEY, DmScanState.serializer()) ?: DmScanState()

    private suspend fun saveScanState(me: String, s: DmScanState) = cache.put(me, SCAN_KEY, DmScanState.serializer(), s, nowSec())

    /**
     * One pass over the inbox (dm.ts scanDmGiftWraps): the steady window since the
     * last scan (unless a live subscription covers it), then up to
     * [DmLogic.HISTORY_PAGES_PER_SCAN] older pages, resumed on later calls.
     * Everything lands in the event store. Returns the wrap ids seen.
     */
    private suspend fun scan(me: String, steady: Boolean): Set<String> = scanLock.withLock {
        if (!nostr.network.value) return@withLock emptySet()
        val now = nowSec()
        val relays = inboxRelays(me)
        var state = scanState(me)
        val ids = HashSet<String>()
        if (steady) {
            val r = nostr.fetch(relays, inboxFilter(me, since = DmLogic.steadySince(state, now)), timeoutMs = 10_000)
            r.events.forEach { ids += it.id }
            if (r.answered > 0) state = state.copy(lastScan = now)
        }
        var until = state.historyUntil
        var complete = state.historyComplete
        var page = 0
        while (!complete && page < DmLogic.HISTORY_PAGES_PER_SCAN) {
            val r = nostr.fetch(relays, inboxFilter(me, until = until, limit = DmLogic.HISTORY_PAGE_LIMIT), timeoutMs = 10_000)
            if (r.answered == 0) break
            r.events.forEach { ids += it.id }
            if (r.events.size < DmLogic.HISTORY_PAGE_LIMIT) { complete = true; until = null; break }
            until = DmLogic.nextHistoryUntil(until, r.events.minOf { it.createdAt })
            page++
        }
        state = state.copy(historyUntil = if (complete) null else until, historyComplete = complete)
        saveScanState(me, state)
        ids
    }

    /** Wraps on the phone addressed to [me] that have no memoized outcome yet, newest first. */
    private suspend fun pending(me: String): List<NostrEvent> {
        val (known, cutoff) = synchronized(memo) {
            memo.keys.toHashSet() to (if (memo.size >= DmLogic.MAX_DM_WRAPS) memo.values.minOf { it.wrapAt } else 0L)
        }
        return nostr.local(inboxFilter(me, since = cutoff.takeIf { it > 0 }))
            .filter { it.id !in known && (attempts[it.id] ?: 0) < DmLogic.MAX_UNWRAP_ATTEMPTS }
            .sortedByDescending { it.createdAt }
    }

    /**
     * Unwrap whatever is pending. [interactive] = the user has Messages open, so a
     * remote signer may show UI; otherwise it runs silently and stops at the first
     * request that would need the user.
     */
    suspend fun unwrapPending(interactive: Boolean) = unwrapLock.withLock {
        val acct = session.account.value ?: return@withLock
        val me = acct.pubkey
        if (owner != me) return@withLock
        val signer = acct.signer
        val todo = pending(me)
        if (todo.isEmpty()) return@withLock
        var n = 0
        for (wrap in todo) {
            if (owner != me) break
            val outcome: DmMemoEntry? = try {
                val rumor = if (interactive || signer.isLocal) accounts.unwrap(wrap, Kinds.ATTENDEE_RUMOR_KINDS)
                else silently { accounts.unwrap(wrap, Kinds.ATTENDEE_RUMOR_KINDS) }
                DmMemoEntry(DmLogic.classify(rumor, me), wrap.createdAt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignerNeedsUser) {
                break // ciphertext stays ciphertext until the user opens Messages
            } catch (e: GiftWrap.UnwrapException) {
                DmMemoEntry(null, wrap.createdAt) // foreign kind, forged seal, malformed: definitive
            } catch (e: Nip44.DecryptException) {
                // On this phone's own key a bad MAC is deterministic; through a remote signer it may be transport.
                if (signer.isLocal) DmMemoEntry(null, wrap.createdAt) else { bump(wrap.id); null }
            } catch (e: Exception) {
                bump(wrap.id); null // transient: retried on the next pass, bounded per process
            }
            if (outcome != null) {
                synchronized(memo) { memo[wrap.id] = outcome }
                if (++n % 20 == 0) { publishSnapshot(); persistMemo(me) }
            }
        }
        if (n > 0) { publishSnapshot(); persistMemo(me) }
        settleActivity(me)
    }

    private fun bump(id: String) = synchronized(memo) { attempts[id] = (attempts[id] ?: 0) + 1 }

    /** Wraps that are no longer ciphertext stop counting as "encrypted activity". */
    private suspend fun settleActivity(me: String) {
        val a = _activity.value
        if (a.pending.isEmpty()) return
        val keys = synchronized(memo) { memo.keys.toHashSet() }
        val left = a.pending.filter { it !in keys }
        if (left.size != a.pending.size) setActivity(me, a.copy(pending = left))
    }

    private suspend fun setActivity(me: String, a: DmActivity) {
        if (owner != me) return
        _activity.value = a
        cache.put(me, ACTIVITY_KEY, DmActivity.serializer(), a, nowSec())
    }

    private suspend fun observeActivity(me: String, ids: Collection<String>) {
        if (ids.isEmpty() && _activity.value.initialized) return
        setActivity(me, DmLogic.observeActivity(_activity.value, ids))
    }

    /**
     * The app came up or back to the foreground: scan once if stale, unwrap
     * silently, pull read state silently. Never prompts a signer.
     */
    fun refreshInBackground(): Job = scope.launch {
        val acct = session.account.value ?: return@launch
        val me = acct.pubkey
        runCatching {
            if (!cache.isFresh("$SCAN_KEY:$me", SCAN_TTL_MS) && nostr.network.value) {
                val ids = scan(me, steady = true)
                cache.markFetched("$SCAN_KEY:$me")
                observeActivity(me, ids)
            }
            unwrapPending(interactive = false)
            runCatching { silently { mutes.refresh(acct.signer, fetch = true) } }
            runCatching { silently { syncReadState(acct.signer, force = false) } }
        }.onFailure { if (it is CancellationException) throw it; Log.w(TAG, "background refresh", it) }
    }

    /**
     * Collect while Messages or a thread is visible: one live subscription for
     * new wraps, a bounded history walk, interactive unwraps and read-state sync.
     * Cancelling (leaving the screen) closes the subscription.
     */
    suspend fun watch(onSettled: () -> Unit = {}) {
        val acct = session.account.value ?: return
        val me = acct.pubkey
        switchTo(me)
        coroutineScope {
            val trigger = Channel<Unit>(Channel.CONFLATED)
            launch {
                for (x in trigger) {
                    runCatching { unwrapPending(interactive = true) }.onFailure { if (it is CancellationException) throw it }
                    acknowledgeEncryptedActivity()
                }
            }
            trigger.trySend(Unit) // what is already on the phone first
            launch { runCatching { mutes.refresh(acct.signer, fetch = true) } }
            launch {
                // History pages (steady state comes from the subscription below).
                runCatching { scan(me, steady = false) }
                runCatching { unwrapPending(interactive = true) }.onFailure { if (it is CancellationException) throw it }
                onSettled()
                runCatching { syncReadState(acct.signer, force = false) }
            }
            // The live inbox, (re)opened whenever the phone is online, from the last cursor.
            nostr.network.collectLatest { online ->
                if (!online) return@collectLatest
                val since = DmLogic.steadySince(scanState(me), nowSec())
                val subscribedAt = nowSec()
                var eosed = false
                nostr.pool.subscribe(inboxRelays(me), listOf(inboxFilter(me, since = since))).collect { m ->
                    when (m) {
                        is RelayPool.Message.Event -> { nostr.store.put(m.event); trigger.trySend(Unit) }
                        is RelayPool.Message.Eose -> if (!eosed) {
                            eosed = true
                            saveScanState(me, scanState(me).copy(lastScan = subscribedAt))
                            cache.markFetched("$SCAN_KEY:$me")
                        }
                        else -> Unit
                    }
                }
            }
        }
    }

    // ── Sending ─────────────────────────────────────────────────────────────

    /**
     * Send [text] to [peer] (hex pubkey). Shows at once (memoized under the self
     * copy); returns [Nostr.PublishResult.Queued] when either copy is waiting in
     * the outbox. This is also what chat's `/msg` calls.
     */
    suspend fun send(peer: String, text: String): Nostr.PublishResult {
        val acct = session.account.value ?: throw IllegalStateException("not signed in")
        val me = acct.pubkey
        switchTo(me)
        val out = DmLogic.wrapDm(acct.signer, peer, text)
        val msg = DmMessage(out.rumorId, peer, me, text, out.createdAt, outWrap = out.toRecipient.id)
        synchronized(memo) { memo[out.toSelf.id] = DmMemoEntry(msg, out.toSelf.createdAt) }
        publishSnapshot()
        persistMemo(me)
        return withContext(Dispatchers.IO) {
            val toPeer = async { nostr.publish(out.toRecipient, inboxRelays(peer), me, "dm") }
            val toSelf = async { nostr.publish(out.toSelf, inboxRelays(me), me, "dm") }
            val results = listOf(toPeer.await(), toSelf.await())
            if (results.all { it is Nostr.PublishResult.Published }) results[0] else Nostr.PublishResult.Queued
        }
    }

    /** "Introduce us": stage a one-shot draft for [peer]'s thread (dm-prefill.svelte.ts). */
    fun stagePrefill(peer: String, text: String) = synchronized(prefills) { prefills[peer] = text }

    fun takePrefill(peer: String): String? = synchronized(prefills) { prefills.remove(peer) }

    suspend fun loadDraft(peer: String): String? = owner?.let { cache.get(it, "$DRAFT_KEY$peer", String.serializer()) }

    suspend fun saveDraft(peer: String, text: String) {
        val me = owner ?: return
        if (text.isBlank()) cache.delete(me, "$DRAFT_KEY$peer") else cache.put(me, "$DRAFT_KEY$peer", String.serializer(), text, nowSec())
    }

    // ── Read state ──────────────────────────────────────────────────────────

    @Volatile private var readDebounce: Job? = null
    @Volatile private var lastPullAt = 0L
    /** The last remote read state we decrypted, by event id: an unchanged event is not decrypted again. */
    @Volatile private var lastRemote: Pair<String, DmReadState?>? = null
    private val readLock = Mutex()

    private suspend fun setWatermarks(me: String, wm: Watermarks) {
        if (owner != me) return
        _watermarks.value = wm
        cache.put(me, READ_KEY, wmSer, wm, nowSec())
    }

    /** The thread is on screen: its newest incoming message is read. */
    fun markThreadRead(peer: String) {
        val me = owner ?: return
        scope.launch {
            val next = DmLogic.markThreadRead(_watermarks.value, _messages.value, me, peer) ?: return@launch
            setWatermarks(me, next)
            scheduleReadPublish()
        }
        acknowledgeEncryptedActivity()
    }

    fun markAllRead() {
        val me = owner ?: return
        scope.launch {
            DmLogic.markAllRead(_watermarks.value, _messages.value, me)?.let { setWatermarks(me, it); scheduleReadPublish() }
            setActivity(me, _activity.value.copy(pending = emptyList()))
        }
    }

    fun acknowledgeEncryptedActivity() {
        val me = owner ?: return
        if (_activity.value.pending.isEmpty()) return
        scope.launch { setActivity(me, _activity.value.copy(pending = emptyList())) }
    }

    private fun scheduleReadPublish() {
        readDebounce?.cancel()
        readDebounce = scope.launch {
            delay(READ_DEBOUNCE_MS)
            readDebounce = null
            session.account.value?.let { runCatching { syncReadState(it.signer, force = true) } }
        }
    }

    /** Publish a debounced read advance now (leaving a DM screen, app to background). */
    fun flushReadState() {
        val j = readDebounce ?: return
        j.cancel(); readDebounce = null
        scope.launch { session.account.value?.let { runCatching { syncReadState(it.signer, force = true) } } }
    }

    /**
     * Read-merge-write of the account's 30078 `nostrautica:dmread` (dm-read-state.ts):
     * pull always (throttled to [PULL_INTERVAL_MS] unless [force]), merge per peer,
     * push only a loaded, non-empty map that differs from the relay's.
     */
    suspend fun syncReadState(signer: NostrSigner, force: Boolean) = readLock.withLock {
        val me = signer.pubkey
        if (owner != me) return@withLock
        val now = System.currentTimeMillis()
        if (!force && now - lastPullAt < PULL_INTERVAL_MS) return@withLock
        nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(me), tags = mapOf("d" to listOf(READ_STATE_D))))
        val latest = nostr.store.latest(Kinds.APP_DATA, me, READ_STATE_D)
        val remote: DmReadState? = when {
            latest == null -> null
            lastRemote?.first == latest.id -> lastRemote?.second
            !Nip44.isCiphertext(latest.content) -> null.also { lastRemote = latest.id to null }
            else -> {
                // A signer that failed to answer (timeout, offline bunker) is NOT "no remote state":
                // republishing ours then would drop what another device recorded. Stop; retry next pull.
                val json = signer.nip44Decrypt(me, latest.content)
                // Unreadable (future schema, corrupt) is "no remote state": ours is republished, healing it.
                val parsed = (Wire.parseSafe(DmReadState.serializer(), json) as? Wire.Result.Ok)?.value
                lastRemote = latest.id to parsed
                parsed
            }
        }
        // Throttle only a pull that worked: a silent one the signer declined must not delay the interactive one.
        lastPullAt = now
        if (remote != null) {
            val merged = DmLogic.mergeWatermarks(_watermarks.value, remote.threads)
            if (!DmLogic.sameWatermarks(merged, _watermarks.value)) setWatermarks(me, merged)
        }
        if (!_loaded.value) return@withLock
        val local = DmLogic.prunedForPublish(_watermarks.value)
        if (local.isEmpty()) return@withLock
        if (remote != null && DmLogic.sameWatermarks(local, remote.threads)) return@withLock
        val state = DmReadState(Wire.PROTOCOL_VERSION, local)
        val content = signer.nip44Encrypt(me, Wire.json.encodeToString(DmReadState.serializer(), state))
        val (ev, _) = accounts.signAndPublish(Kinds.APP_DATA, content, listOf(listOf("d", READ_STATE_D)), Relays.DEFAULT, "dm read state")
        lastRemote = ev.id to state
    }

    companion object {
        private const val TAG = "Dms"
        const val MEMO_KEY = "dmwraps"
        const val SCAN_KEY = "dmscanat"
        const val READ_KEY = "dm-read-watermarks"
        const val ACTIVITY_KEY = "dm-encrypted-activity"
        const val DRAFT_KEY = "draft:dm:"
        const val READ_STATE_D = "nostrautica:dmread"
        const val SCAN_TTL_MS = 2 * 60_000L
        const val PULL_INTERVAL_MS = 60_000L
        const val READ_DEBOUNCE_MS = 4_000L
    }
}
