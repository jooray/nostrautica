package today.cypherpunk.nostrautica.domain.chat

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.protocol.RosterContent

/**
 * One event's chat on this phone (chat/session.svelte.ts + chat/client.ts).
 *
 * Lifecycle: [start] when the chat screen becomes visible, [stop] when it goes
 * away; the MLS runtime is held only in between. What it does while running:
 *
 * 1. this phone's chat device key for the account (minted on first use) becomes
 *    an MDK account advertising the event's chat relays — MDK publishes its 10002,
 *    10050 and key package;
 * 2. the device's own kind-0 goes to the chat relays (NIP §10.3);
 * 3. unless already in the room, a 21607 `add` with proof of possession tells the
 *    coordinator to add this device (and an evicted device rotates its key package
 *    first, because the old one was spent on the Add it was removed from);
 * 4. MDK receives the Welcome; the group is bound to the event only when its Nostr
 *    group id equals the roster's `nostr_group_id` and the coordinator sealed it,
 *    and only then is the pending invite accepted and the timeline shown.
 *
 * Membership is read from our own leaf, never from "a group exists": a removed
 * member keeps the group and its history, and that state renders as EVICTED.
 */
class ChatSession internal constructor(
    private val chat: Chat,
    val ctx: EventContext,
    val account: String,
    private val engine: ChatEngine,
) {
    enum class Phase { STARTING, SETUP, READY, EVICTED, ERROR }

    enum class Attest { NONE, SENT, QUEUED, FAILED }

    data class State(
        val phase: Phase = Phase.STARTING,
        val chatPubkey: String? = null,
        val messages: List<ChatMessage> = emptyList(),
        val hasMoreBefore: Boolean = false,
        /** Device keys holding a leaf in this event's group; null while unknown. */
        val groupDevices: List<String>? = null,
        val roster: RosterContent? = null,
        /** Setup progress: the key package is out (MDK NETWORK_READY). */
        val keyPackageReady: Boolean = false,
        val attest: Attest = Attest.NONE,
        /** A group sealed by the coordinator exists but the roster doesn't name it (yet). */
        val unverifiedGroup: Boolean = false,
        val setupSince: Long = System.currentTimeMillis(),
        val rejoining: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> get() = _state

    private var job: Job? = null
    private val reconcileLock = Mutex()
    private var accountRef: String? = null
    private var device: ChatDeviceKeys.Device? = null
    private var boundGroup: String? = null
    private var timeline: ChatEngine.TimelineHandle? = null
    private var timelineJob: Job? = null
    private var enrolled = false
    /** The roster has been fetched (or the fetch failed) at least once this run. */
    @Volatile private var rosterChecked = false
    private var rejoinRequested = false
    private val coordinator get() = ctx.cfg.coordinator

    val groupId: String? get() = boundGroup

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        job = chat.scope.launch { run() }
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    /** "Try again": tear down and start from scratch (the old run fully ends first). */
    @Synchronized
    fun retry() {
        val old = job
        job = chat.scope.launch {
            old?.cancelAndJoin()
            enrolled = false
            rosterChecked = false
            _state.update { State(roster = it.roster, chatPubkey = it.chatPubkey) }
            run()
        }
    }

    private suspend fun run() {
        var acquired = false
        try {
            engine.acquire()
            acquired = true
            val chatRelays = chat.chatRelays(ctx)
            // A new device key is minted by the engine itself (no import-time
            // discovery). A stored key the engine doesn't know is imported; if that
            // import can't complete, a key never attested is safely replaced.
            var d = chat.keys.peek(account)
            if (d != null && !engine.hasAccount(d.pubkey)) {
                val stored = d
                val imported = runCatching { engine.ensureAccount(stored, ChatDeviceKeys.mergeRelays(chat.keys.advertisedRelays(stored.pubkey), chatRelays), chatRelays) }
                if (imported.isFailure && !chat.isAttested(account, ctx, stored.pubkey)) {
                    Log.w(TAG, "device key import failed (${imported.exceptionOrNull()?.javaClass?.simpleName}); minting a new one")
                    chat.keys.discard(account)
                    d = null
                } else imported.getOrThrow()
            }
            if (d == null) d = chat.keys.adopt(account, engine.createDeviceIdentity(chatRelays, chatRelays))
            device = d
            _state.update { it.copy(chatPubkey = d.pubkey, error = null, phase = if (it.phase == Phase.ERROR) Phase.STARTING else it.phase) }
            val advertised = ChatDeviceKeys.mergeRelays(chat.keys.advertisedRelays(d.pubkey), chatRelays)
            val roster0 = chat.cachedRoster(account, ctx.coordinate)
            _state.update { it.copy(roster = roster0) }
            chat.warmProfiles(roster0, chatRelays)
            val ref = engine.ensureAccount(d, advertised, chatRelays)
            chat.keys.saveAdvertisedRelays(d.pubkey, advertised)
            accountRef = ref
            coroutineScope {
                launch { runCatching { chat.publishDeviceProfile(d, chatRelays) }.onFailure { Log.w(TAG, "device profile: ${it.javaClass.simpleName}") } }
                launch {
                    chat.fetchRoster(ctx, account)?.let { r -> _state.update { it.copy(roster = r) }; chat.warmProfiles(r, chatRelays) }
                    rosterChecked = true
                    reconcile()
                }
                launch { engine.changes(ref).conflate().collect { reconcile(); delay(300) } }
                launch {
                    // While not in the room, keep looking: the Welcome, a roster that now
                    // names the group, the coordinator's refusal. Stops costing anything
                    // once joined.
                    var tick = 0
                    while (true) {
                        delay(if (_state.value.phase == Phase.READY) 60_000 else 8_000)
                        tick++
                        if (_state.value.phase != Phase.READY) {
                            if (tick % 3 == 0) chat.fetchRoster(ctx, account)?.let { r -> _state.update { it.copy(roster = r) } }
                            if (!_state.value.keyPackageReady) _state.update { it.copy(keyPackageReady = engine.networkReady(ref)) }
                        }
                        reconcile()
                    }
                }
                reconcile()
                awaitCancellation()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "chat session failed: ${e.javaClass.simpleName}")
            _state.update { it.copy(phase = Phase.ERROR, error = e.message ?: e.javaClass.simpleName) }
        } finally {
            timelineJob?.cancel(); timelineJob = null
            timeline?.close(); timeline = null
            boundGroup = null
            if (acquired) engine.release()
        }
    }

    /** Re-read MDK's groups and settle binding, invites, phase and timeline. */
    suspend fun reconcile() = reconcileLock.withLock {
        val ref = accountRef ?: return@withLock
        val d = device ?: return@withLock
        val coord = coordinator
        try {
            var groups = engine.groups(ref)
            val rosterGid = _state.value.roster?.nostrGroupId
            // Accept only the invitation the roster names, sealed by this coordinator.
            GroupBinding.acceptable(groups, coord).filter { rosterGid != null && it.nostrGroupIdHex.equals(rosterGid, true) }.forEach {
                engine.acceptInvite(ref, it.groupIdHex)
            }
            var binding = GroupBinding.select(groups, rosterGid, coord)
            // A re-add Welcome into a group we hold stale state for comes as a rejoin
            // offer. Taking it is right when we are out of the room, or asked to rejoin.
            if (binding is GroupBinding.Result.Bound && coord != null && (!binding.group.selfMember || rejoinRequested)) {
                if (engine.confirmRejoin(ref, binding.group.groupIdHex, coord)) {
                    groups = engine.groups(ref)
                    binding = GroupBinding.select(groups, rosterGid, coord)
                }
            }
            val phase = when (GroupBinding.phase(binding)) {
                GroupBinding.Phase.READY -> Phase.READY
                GroupBinding.Phase.EVICTED -> Phase.EVICTED
                GroupBinding.Phase.SETUP -> Phase.SETUP
            }
            val bound = (binding as? GroupBinding.Result.Bound)?.group
            val unverified = bound == null && coord != null && groups.any { it.welcomer == coord }
            if (phase == Phase.READY) rejoinRequested = false
            _state.update {
                it.copy(
                    phase = phase,
                    groupDevices = bound?.members,
                    unverifiedGroup = unverified,
                    setupSince = if (it.phase != Phase.SETUP && phase == Phase.SETUP) System.currentTimeMillis() else it.setupSince,
                    keyPackageReady = it.keyPackageReady || phase == Phase.READY,
                )
            }
            if (bound != null && bound.groupIdHex != boundGroup) bindTimeline(ref, bound.groupIdHex, d.pubkey)
            // Never ask to be added while we may already be in the room and just can't
            // prove it yet (no roster id at hand): a fresh attestation from a device
            // that holds a leaf makes the coordinator remove and re-add it, and every
            // message in between is lost to it for good.
            val maybeInRoom = binding is GroupBinding.Result.Unverified &&
                groups.any { it.selfMember && (it.welcomer == null || it.welcomer == coord) }
            val rosterKnown = rosterChecked || _state.value.roster != null
            if (phase != Phase.READY && !enrolled && rosterKnown && !maybeInRoom) enroll(ref, d, evicted = phase == Phase.EVICTED)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "reconcile: ${e.javaClass.simpleName}")
        }
    }

    /** Ask the coordinator to add this device (client.ts ensurePublished). Once per session. */
    private suspend fun enroll(ref: String, d: ChatDeviceKeys.Device, evicted: Boolean) {
        enrolled = true
        if (evicted) runCatching { engine.rotateKeyPackage(ref) }.onFailure { Log.w(TAG, "rotate: ${it.javaClass.simpleName}") }
        _state.update { it.copy(keyPackageReady = it.keyPackageReady || engine.networkReady(ref)) }
        sendAdd(d)
    }

    private suspend fun sendAdd(d: ChatDeviceKeys.Device) {
        val label = chat.keys.label(d.pubkey) ?: MarmotEngine.defaultDeviceLabel()
        val r = runCatching { chat.attest(ctx, ChatAttest.Op.ADD, d.pubkey, label, d.clientId, d.secret) }
        r.onFailure { Log.w(TAG, "attest: ${it.javaClass.simpleName}") }
        _state.update { it.copy(attest = r.fold({ ok -> if (ok) Attest.SENT else Attest.QUEUED }, { Attest.FAILED })) }
    }

    private fun bindTimeline(ref: String, gid: String, me: String) {
        timelineJob?.cancel()
        timeline?.close()
        boundGroup = gid
        val h = engine.timeline(ref, gid, me)
        timeline = h
        timelineJob = chat.scope.launch {
            runCatching {
                h.pages.collect { p -> _state.update { it.copy(messages = p.messages, hasMoreBefore = p.hasMoreBefore) } }
            }.onFailure { if (it !is CancellationException) Log.w(TAG, "timeline: ${it.javaClass.simpleName}") }
        }
    }

    suspend fun loadOlder() {
        val p = timeline?.older(50) ?: return
        _state.update { it.copy(messages = p.messages, hasMoreBefore = p.hasMoreBefore) }
    }

    class Unroutable : Exception("this device is not in the event's chat group")

    /** Send a kind-9. Throws [Unroutable] when the device is out of the room. */
    suspend fun send(text: String): Boolean {
        val ref = accountRef ?: throw Unroutable()
        val gid = boundGroup
        if (gid == null || _state.value.phase != Phase.READY) throw Unroutable()
        return try {
            engine.sendText(ref, gid, text)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            reconcile()
            if (_state.value.phase != Phase.READY) throw Unroutable()
            throw e
        }
    }

    suspend fun toggleReaction(m: ChatMessage, emoji: String) {
        val ref = accountRef ?: return
        val gid = boundGroup ?: return
        val mine = m.reactions.firstOrNull { it.mine }
        if (mine?.emoji == emoji) engine.unreact(ref, gid, m.id) else engine.react(ref, gid, m.id, emoji)
    }

    /**
     * "Rejoin this chat" (client.ts rejoin; MARMOT-GROUP-CHAT.md "Rejoining a
     * device"): revoke this device (drops the coordinator-held leaf), rotate the
     * key package (a new event id the coordinator has not consumed), re-attest.
     * Same device key, label and device slot. A re-add Welcome already waiting is
     * taken instead, since revoking would remove the leaf it is for.
     */
    suspend fun rejoin(force: Boolean = true) {
        if (_state.value.rejoining) return
        val ref = accountRef ?: throw IllegalStateException("no chat session")
        val d = device ?: throw IllegalStateException("no chat session")
        if (!force && _state.value.phase == Phase.READY) return
        _state.update { it.copy(rejoining = true, phase = Phase.SETUP, setupSince = System.currentTimeMillis()) }
        try {
            rejoinRequested = true
            val gid = boundGroup
            val coord = coordinator
            if (gid != null && coord != null && engine.confirmRejoin(ref, gid, coord)) { reconcile(); return }
            chat.attest(ctx, ChatAttest.Op.REVOKE, d.pubkey)
            engine.rotateKeyPackage(ref)
            enrolled = true
            sendAdd(d)
            reconcile()
        } finally {
            _state.update { it.copy(rejoining = false) }
        }
    }

    /** Re-read the roster (after a device rename/revoke, or when the screen asks). */
    suspend fun refreshRoster() {
        chat.fetchRoster(ctx, account)?.let { r -> _state.update { it.copy(roster = r) } }
    }

    fun applyRoster(r: RosterContent?) { if (r != null) _state.update { it.copy(roster = r) } }

    companion object {
        private const val TAG = "ChatSession"
        /** chat/EventChat.svelte: the "taking longer than usual" hint. */
        const val SETUP_SLOW_MS = 25_000L
    }
}
