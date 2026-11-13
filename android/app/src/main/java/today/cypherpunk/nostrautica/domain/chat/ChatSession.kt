package today.cypherpunk.nostrautica.domain.chat

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.nowSec

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
 * 3. only on positive evidence that it is out of the room ([ChatPolicy]), a 21607
 *    `add` with proof of possession tells the coordinator to add this device (and an
 *    evicted device rotates its key package first, because the old one was spent on
 *    the Add it was removed from). "Can't tell yet" never attests: to the
 *    coordinator an `add` from a device that holds a leaf is a re-enrolment;
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

    /** Why setup is not moving although nothing is known to be wrong with membership. */
    enum class Problem {
        /** MDK's group list (or one group's details) could not be read. */
        GROUPS_UNREADABLE,
        /** The room's invitation is here but accepting it failed. */
        INVITE_FAILED,
    }

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
        /** The newest `chat_attestation` refusal from the coordinator, as a string key. */
        val refusalKey: String? = null,
        val setupSince: Long = System.currentTimeMillis(),
        val rejoining: Boolean = false,
        /**
         * Positive eviction ([ChatPolicy.offerRejoin]): the only state in which
         * "Rejoin" (a guaranteed remove + add) is offered.
         */
        val offerRejoin: Boolean = false,
        /**
         * The room's local copy is stalled, forked or frozen, or its history may be
         * incomplete (MDK, audit R-9): "re-syncing, some messages may be missing".
         * Never a reason to offer Rejoin.
         */
        val resyncing: Boolean = false,
        /** A local read or the invitation accept is failing; retried on every reconcile. */
        val problem: Problem? = null,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> get() = _state

    private val reconcileLock = Mutex()
    private var accountRef: String? = null
    private var device: ChatDeviceKeys.Device? = null
    private var boundGroup: String? = null
    private var timeline: ChatEngine.TimelineHandle? = null
    private var timelineJob: Job? = null
    /** The automatic-attestation spacing and refusal-retry latches. Survive [retry] on purpose. */
    private val enrolment = Enrolment()
    private var lastAttestSec = 0L
    /** When a roster with attendees was last fetched from the relays (0: not yet). */
    @Volatile private var rosterFreshAtMs = 0L
    /** Since when the device has been seen removed from the room, in a row. */
    private var evictedSinceMs: Long? = null
    private var rejoinRequested = false
    private val coordinator get() = ctx.cfg.coordinator

    val groupId: String? get() = boundGroup

    /** At most one [run] alive at a time, across start, stop and retry. */
    private val runs = SessionRuns(chat.scope)

    /**
     * Start (or resume) the session. The phase goes back to STARTING: whatever the
     * last run knew (READY included) is not known of this one until it reconciles,
     * and a READY carried over with no bound group made the first send fail as
     * "unroutable" and offer Rejoin (audit K-6).
     */
    fun start() = runs.start({
        _state.update { it.copy(phase = Phase.STARTING, setupSince = System.currentTimeMillis(), offerRejoin = false, error = null) }
        // In the background, so the first attestation usually knows whether the
        // coordinator takes the add `intent` (NIP §6.2). Never waited for.
        chat.prefetchIntentSupport(coordinator)
    }) { run() }

    fun stop() = runs.stop()

    /**
     * "Try again": tear down and start from scratch (the old run fully ends first,
     * however many presses came in between: [SessionRuns], A-1). It never attests by
     * itself: the automatic-attestation spacing survives it, so a press can't turn
     * into a re-enrolment (K-6).
     */
    fun retry() = runs.retry({
        _state.update { State(roster = it.roster, chatPubkey = it.chatPubkey, messages = it.messages, hasMoreBefore = it.hasMoreBefore) }
    }) { run() }

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
                // Replacing the key is only safe when a FRESH roster shows it was never
                // attested (K-4): a cached roster can predate the attestation, and a new
                // key for a device the coordinator holds a leaf for strands that leaf.
                // "Fresh" is the read's own provenance, never assumed (KIMIK31 A-3).
                if (imported.isFailure && ChatPolicy.mayReplaceUnimportableKey(fetchRosterNow(), account, stored.pubkey)) {
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
            var ref = engine.ensureAccount(d, advertised, chatRelays)
            // Widening the inbox to this event's relays breaks MDK's group subscriptions
            // until a restart; do it now, before anything of ours is bound to the runtime.
            if (engine.refreshIfStale()) ref = engine.ensureAccount(d, advertised, chatRelays)
            chat.keys.saveAdvertisedRelays(d.pubkey, advertised)
            accountRef = ref
            coroutineScope {
                launch { runCatching { chat.publishDeviceProfile(d, chatRelays) }.onFailure { Log.w(TAG, "device profile: ${it.javaClass.simpleName}") } }
                launch {
                    // Coming back to the screen within a minute reuses the last roster (S-2).
                    fetchRosterNow(ChatPolicy.ROSTER_REUSE_MS)?.let { r -> chat.warmProfiles(r.roster, chatRelays) }
                    reconcile()
                }
                launch {
                    engine.changes(ref)
                        .filter { ChatPolicy.needsReconcile(it.kind, _state.value.phase == Phase.READY && boundGroup != null) }
                        .conflate().collect { reconcile(); delay(300) }
                }
                launch {
                    // While not in the room, keep looking: the Welcome, a roster that now
                    // names the group, the coordinator's refusal. Every 8 s for the first
                    // two minutes, then every 60 s (R-8); once joined, only the 60 s backstop.
                    var notReadySince = System.currentTimeMillis()
                    while (true) {
                        val ready = _state.value.phase == Phase.READY
                        if (ready) notReadySince = System.currentTimeMillis()
                        delay(ChatPolicy.pollDelayMs(ready, System.currentTimeMillis() - notReadySince))
                        if (_state.value.phase != Phase.READY) {
                            if (System.currentTimeMillis() - rosterFreshAtMs >= ChatPolicy.POLL_ROSTER_MS) fetchRosterNow()
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
            // A reconcile from send() after this would act on a released runtime.
            accountRef = null
            // Nothing is bound any more, so nothing is READY (the phantom READY after stop()).
            _state.update { if (it.phase == Phase.READY) it.copy(phase = Phase.STARTING) else it }
            if (acquired) engine.release()
        }
    }

    /** Re-read MDK's groups and settle binding, invites, phase and timeline. */
    suspend fun reconcile() = reconcileLock.withLock {
        val ref = accountRef ?: return@withLock
        val d = device ?: return@withLock
        val coord = coordinator
        try {
            var groups = try {
                engine.groups(ref)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Say so instead of waiting in silence; the next reconcile retries.
                Log.w(TAG, "groups: ${e.javaClass.simpleName}")
                _state.update { it.copy(problem = Problem.GROUPS_UNREADABLE) }
                // MDK 0.16: a group quarantined until the next account open makes the
                // list unreadable, and only a reopen clears it (once, RuntimeFreshness).
                if (engine.refreshIfStale()) unbindTimeline()
                return@withLock
            }
            val rosterGid = _state.value.roster?.nostrGroupId
            // Accept only the invitation the roster names, sealed by this coordinator.
            var acceptFailed = false
            var accepted = false
            GroupBinding.acceptable(groups, coord).filter { rosterGid != null && it.nostrGroupIdHex.equals(rosterGid, true) }.forEach {
                if (engine.acceptInvite(ref, it.groupIdHex)) accepted = true else acceptFailed = true
            }
            if (accepted) groups = engine.groups(ref)
            var binding = GroupBinding.select(groups, rosterGid, coord)
            // A re-add Welcome into a group we hold stale state for comes as a rejoin
            // offer. Taking it is right when we are out of the room, or asked to rejoin.
            if (binding is GroupBinding.Result.Bound && coord != null && (!binding.group.selfMember || rejoinRequested)) {
                if (engine.confirmRejoin(ref, binding.group.groupIdHex, coord)) {
                    groups = engine.groups(ref)
                    binding = GroupBinding.select(groups, rosterGid, coord)
                }
            }
            // A confirmed rejoin restarts the runtime once so its start registers the
            // group afresh. A plain join does not: MDK subscribes a joined group itself,
            // and a restart here left the room with no live subscription while MDK
            // closed and reopened its store (see RuntimeFreshness). A no-op unless the
            // engine recorded a rejoin or a relay-list change.
            if (engine.refreshIfStale()) {
                unbindTimeline()
                groups = engine.groups(ref)
                binding = GroupBinding.select(groups, rosterGid, coord)
            }
            settle(ref, d, groups, binding, if (acceptFailed) Problem.INVITE_FAILED else null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Unknown, so nothing is decided from it: no phase change, no attestation.
            Log.w(TAG, "reconcile: ${e.javaClass.simpleName}")
        }
    }

    /** Phase, binding and (only on positive evidence, [ChatPolicy]) an attestation. */
    private suspend fun settle(ref: String, d: ChatDeviceKeys.Device, groups: List<GroupBinding.GroupInfo>, binding: GroupBinding.Result, problem: Problem?) {
        val coord = coordinator
        val now = System.currentTimeMillis()
        val gphase = GroupBinding.phase(binding)
        val phase = when (gphase) {
            GroupBinding.Phase.READY -> Phase.READY
            GroupBinding.Phase.EVICTED -> Phase.EVICTED
            GroupBinding.Phase.SETUP -> Phase.SETUP
        }
        evictedSinceMs = if (phase == Phase.EVICTED) evictedSinceMs ?: now else null
        val evictedFor = evictedSinceMs?.let { now - it }
        val bound = (binding as? GroupBinding.Result.Bound)?.group
        val held = bound ?: (binding as? GroupBinding.Result.Unconfirmed)?.group
        val health = held?.let { g ->
            runCatching { engine.syncHealth(ref, g.groupIdHex, g.unrecoverable) }.onFailure { if (it is CancellationException) throw it }.getOrNull()
        }
        val unverified = bound == null && coord != null && groups.any { it.welcomer == coord }
        if (phase == Phase.READY) rejoinRequested = false
        // The coordinator's word on our attestation (21606, from the local cache).
        val statuses = if (phase == Phase.READY) emptyList() else runCatching { chat.ownStatuses(account, ctx.coordinate) }.getOrDefault(emptyList())
        val refusal = statuses.filter { it.stage == ExternalLink.ATTESTATION_STAGE && it.state == "poison" }.maxByOrNull { it.at }
        val refusalRetry = !enrolment.refusalRetried && lastAttestSec > 0 && refusal != null && refusal.at >= lastAttestSec &&
            refusal.errorCategory in ChatPolicy.RETRYABLE_REFUSALS
        val roster = _state.value.roster
        val says = ChatPolicy.rosterSays(roster, now - rosterFreshAtMs < ChatPolicy.ROSTER_FRESH_MS, account, d.pubkey)
        val decision = ChatPolicy.decide(groups, binding, says, roster?.nostrGroupId, coord, evictedFor, refusalRetry)
        val refusalKey = if (phase == Phase.READY) null else ExternalLink.setupRefusalKey(statuses)
        _state.update {
            it.copy(
                phase = phase,
                groupDevices = bound?.members,
                unverifiedGroup = unverified,
                refusalKey = refusalKey,
                offerRejoin = ChatPolicy.offerRejoin(gphase, evictedFor, says, refusalKey != null),
                resyncing = if (held == null) false else health?.resyncing ?: it.resyncing,
                problem = problem,
                // A fresh "Connecting" window when the room is lost, not on the first
                // STARTING → SETUP step of a start (start() opened that window).
                setupSince = if ((it.phase == Phase.READY || it.phase == Phase.EVICTED) && phase == Phase.SETUP) now else it.setupSince,
                keyPackageReady = it.keyPackageReady || phase == Phase.READY,
            )
        }
        if (bound != null && bound.groupIdHex != boundGroup) bindTimeline(ref, bound.groupIdHex, d.pubkey)
        if (enrolment.allowed(decision, now, refusalRetry)) {
            Log.i(TAG, "attesting: ${decision.why}")
            val attest = decision as ChatPolicy.Decision.Attest
            enroll(ref, d, attest.rotate, refusalRetry, attest.intent)
        } else if (phase != Phase.READY) {
            Log.d(TAG, "not attesting: ${decision.why}")
        }
    }

    /**
     * Ask the coordinator to add this device (client.ts ensurePublished). A required
     * rotation that fails sends nothing and consumes no latch ([Enrolment], A-2).
     */
    private suspend fun enroll(ref: String, d: ChatDeviceKeys.Device, rotate: Boolean, refusalRetry: Boolean, intent: ChatAttest.Intent) {
        val sent = enrolment.enroll(rotate, refusalRetry, rotateKeyPackage = {
            try {
                engine.rotateKeyPackage(ref)
            } catch (e: Exception) {
                if (e !is CancellationException) Log.w(TAG, "rotate: ${e.javaClass.simpleName}; not attesting on the old key package")
                throw e
            }
        }) {
            _state.update { it.copy(keyPackageReady = it.keyPackageReady || engine.networkReady(ref)) }
            sendAdd(d, intent)
        }
        if (!sent) _state.update { it.copy(attest = Attest.FAILED) }
    }

    /**
     * Fetch the roster from the relays, or reuse one fetched under [reuseMs] ago. Only
     * a roster with attendees is applied: an empty one is what the fetch returns when
     * no relay had it. Only one a relay just sent counts as fresh ([RosterReads]); a
     * read the phone answered from its own store is shown but decides nothing (A-3).
     */
    private suspend fun fetchRosterNow(reuseMs: Long = 0): RosterReads.Fetched? {
        val f = chat.fetchRoster(ctx, account, reuseMs) ?: return null
        if (f.roster.attendees.isEmpty()) return null
        rosterFreshAtMs = ChatPolicy.rosterFreshAt(rosterFreshAtMs, f)
        _state.update { it.copy(roster = f.roster) }
        return f
    }

    private suspend fun sendAdd(d: ChatDeviceKeys.Device, intent: ChatAttest.Intent) {
        val label = chat.keys.label(d.pubkey) ?: MarmotEngine.defaultDeviceLabel()
        lastAttestSec = nowSec()
        // `intent` only to a coordinator that advertises "attest-intent" (NIP §6.2);
        // otherwise, or while its announcement is unknown, the bare 0.17 add.
        val sent = ChatAttest.intentFor(intent, chat.knownIntentSupport(coordinator))
        chat.prefetchIntentSupport(coordinator)
        val r = runCatching { chat.attestTimed(ctx, ChatAttest.Op.ADD, d.pubkey, label, d.clientId, d.secret, intent = sent) }
        r.onFailure { Log.w(TAG, "attest: ${it.javaClass.simpleName}") }
        r.getOrNull()?.let { lastAttestSec = it.createdAt }
        _state.update { it.copy(attest = r.fold({ a -> if (a.published) Attest.SENT else Attest.QUEUED }, { Attest.FAILED })) }
    }

    private fun unbindTimeline() {
        timelineJob?.cancel(); timelineJob = null
        timeline?.close(); timeline = null
        boundGroup = null
    }

    private fun bindTimeline(ref: String, gid: String, me: String) {
        unbindTimeline()
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

    /**
     * Send a kind-9. Throws [Unroutable] when the device is not (or not yet) routed
     * to the room, and only after a reconcile still says so: a send right after
     * resuming used to fail on the not-yet-rebound group (K-6).
     */
    suspend fun send(text: String): Boolean {
        val ref = accountRef ?: throw Unroutable()
        if (boundGroup == null || _state.value.phase != Phase.READY) reconcile()
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
     * Replace the text of our own message [m] (kind 1009 through MDK). Returns
     * false when there was nothing to send (empty or unchanged). Throws
     * [Unroutable] when the device is out of the room.
     */
    suspend fun edit(m: ChatMessage, text: String): Boolean {
        val (ref, gid) = ownAction(m)
        val next = MessageActions.editedText(m.text, text) ?: return false
        engine.edit(ref, gid, m.id, next)
        return true
    }

    /** Delete our own message [m] for everyone (kind 5 through MDK). */
    suspend fun delete(m: ChatMessage) {
        val (ref, gid) = ownAction(m)
        engine.delete(ref, gid, m.id)
    }

    private fun ownAction(m: ChatMessage): Pair<String, String> {
        val ref = accountRef ?: throw Unroutable()
        val gid = boundGroup
        if (gid == null || _state.value.phase != Phase.READY) throw Unroutable()
        // Every receiving client drops an edit or delete from anyone but the author.
        require(MessageActions.canModify(m, _state.value.chatPubkey)) { "only your own messages can be changed" }
        return ref to gid
    }

    /**
     * "Rejoin this chat" (client.ts rejoin; MARMOT-GROUP-CHAT.md "Rejoining a
     * device"): revoke this device (drops the coordinator-held leaf), rotate the
     * key package (a new event id the coordinator has not consumed), re-attest.
     * Same device key, label and device slot. A re-add Welcome already waiting is
     * taken instead, since revoking would remove the leaf it is for.
     *
     * The revoke must have REACHED a relay before the add goes out: the coordinator
     * orders attestations by `created_at`, so a revoke left in the outbox and
     * published after the add would remove the re-added device for good. That is
     * [RevokeNotPublished]: the queued revoke is discarded and nothing else is sent.
     * The add also carries a
     * `created_at` at least one second after the revoke's, as the web app's does.
     */
    suspend fun rejoin(force: Boolean = true) {
        if (_state.value.rejoining) return
        val ref = accountRef ?: throw IllegalStateException("no chat session")
        val d = device ?: throw IllegalStateException("no chat session")
        if (!force && _state.value.phase == Phase.READY) return
        val before = _state.value
        _state.update { it.copy(rejoining = true, phase = Phase.SETUP, setupSince = System.currentTimeMillis()) }
        try {
            rejoinRequested = true
            val gid = boundGroup
            val coord = coordinator
            if (gid != null && coord != null && engine.confirmRejoin(ref, gid, coord)) { reconcile(); return }
            val revoke = chat.attestTimed(ctx, ChatAttest.Op.REVOKE, d.pubkey)
            if (!revoke.published) {
                // Take it back out of the outbox (sent later it would land out of order),
                // leave the room state as it was, and say why.
                runCatching { chat.discardQueued(revoke.wrapId) }
                _state.update { it.copy(phase = before.phase, setupSince = before.setupSince) }
                throw RevokeNotPublished()
            }
            engine.rotateKeyPackage(ref)
            while (nowSec() <= revoke.createdAt) delay(200)
            enrolment.attestedNow()
            // The user asked to be put back (NIP §10.2 `intent:"rejoin"`).
            sendAdd(d, ChatAttest.Intent.REJOIN)
            reconcile()
        } finally {
            _state.update { it.copy(rejoining = false) }
        }
    }

    /** The revoke of a rejoin only reached the outbox, so the rejoin stopped there. */
    class RevokeNotPublished : Exception("the revoke has not reached a relay")

    /** Re-read the roster (after a device rename/revoke, or when the screen asks). */
    suspend fun refreshRoster() {
        fetchRosterNow()
    }

    fun applyRoster(r: RosterContent?) { if (r != null) _state.update { it.copy(roster = r) } }

    companion object {
        private const val TAG = "ChatSession"
    }
}
