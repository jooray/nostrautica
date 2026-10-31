package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.protocol.RosterContent

/**
 * When this device asks the coordinator to add it (a 21607 `add`), kept apart from
 * the binding phase (audit K-4).
 *
 * Every `add` from a device that still holds a leaf is, to the coordinator, a
 * re-enrolment warrant: it removes the leaf and adds the device back, two visible
 * membership changes, and every message in between is lost to the device. So the
 * session attests only on POSITIVE evidence that it is out, never on "can't tell":
 *
 * - a freshly fetched roster does not list this chat key for the account;
 * - the coordinator refused the attestation this session sent, for a reason a
 *   new key package can fix (a 21606 `chat_attestation` poison notice);
 * - the fresh roster names a room, this device holds no copy of it, and holds no
 *   other group the coordinator sealed either (joined or still pending);
 * - this device was removed (MDK `selfMembership`) and the coordinator's re-add
 *   Welcome has not arrived within [EVICTED_GRACE_MS]. The re-add travels as a
 *   gift wrap, separately from the commit that removed us, and usually arrives
 *   later; attesting before it does makes the coordinator evict and re-add again
 *   (feedback loop A-1).
 *
 * Unknown (group list unreadable, roster missing, stale, undecryptable or empty)
 * always waits.
 */
object ChatPolicy {
    /** How long an evicted device waits for the coordinator's re-add Welcome before enrolling. */
    const val EVICTED_GRACE_MS = 90_000L

    /** A roster fetched no longer ago than this counts as fresh for an attest decision. */
    const val ROSTER_FRESH_MS = 120_000L

    /** A roster fetched no longer ago than this is reused instead of fetched again (S-2). */
    const val ROSTER_REUSE_MS = 60_000L

    /** "Connecting": for this long after a start the screen offers no action at all (U-1). */
    const val CONNECTING_MS = 30_000L

    /** An automatic attestation is not repeated sooner than this (a refusal retry aside). */
    const val REATTEST_MIN_MS = 10 * 60_000L

    /** Refusals a fresh key package or a fresh proof can fix, so one more attempt is worth it. */
    val RETRYABLE_REFUSALS = setOf("chat_key_package_ineligible", "chat_proof_invalid")

    /** What a roster says about this device's chat key. */
    enum class RosterSays { UNKNOWN, LISTED, NOT_LISTED }

    /**
     * [roster] must be fresh to count. An empty attendee list is UNKNOWN: it is what
     * the roster fetch returns when no relay had the roster event at all, and a real
     * roster of an event whose chat we can open lists at least us.
     */
    fun rosterSays(roster: RosterContent?, fresh: Boolean, account: String, chatPubkey: String): RosterSays {
        if (!fresh || roster == null || roster.attendees.isEmpty()) return RosterSays.UNKNOWN
        val listed = roster.attendees.firstOrNull { it.pubkey.equals(account, true) }?.chatKeys.orEmpty().any { it.pubkey.equals(chatPubkey, true) }
        return if (listed) RosterSays.LISTED else RosterSays.NOT_LISTED
    }

    sealed interface Decision {
        val why: String
        data class Wait(override val why: String) : Decision
        /** Send a 21607 `add`; [rotate] first publishes a fresh key package (the old one may be spent). */
        data class Attest(val rotate: Boolean, override val why: String) : Decision
    }

    /**
     * @param groups MDK's groups for this device, or null when they could not all be read.
     * @param binding the routing result over [groups].
     * @param evictedForMs how long the device has been seen EVICTED in a row, null when it isn't.
     * @param refusalRetry the coordinator refused this session's attestation for a fixable reason.
     */
    fun decide(
        groups: List<GroupBinding.GroupInfo>?,
        binding: GroupBinding.Result,
        rosterSays: RosterSays,
        rosterGroupId: String?,
        coordinator: String?,
        evictedForMs: Long?,
        refusalRetry: Boolean,
    ): Decision {
        val coord = coordinator?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Decision.Wait("no coordinator")
        if (groups == null) return Decision.Wait("group list unreadable")
        val phase = GroupBinding.phase(binding)
        if (phase == GroupBinding.Phase.READY) return Decision.Wait("in the room")
        if (refusalRetry) return Decision.Attest(rotate = true, "the coordinator refused the last attestation")
        val evicted = phase == GroupBinding.Phase.EVICTED
        return when (rosterSays) {
            RosterSays.UNKNOWN -> Decision.Wait("roster not freshly known")
            RosterSays.NOT_LISTED -> Decision.Attest(rotate = evicted, "the roster does not list this device")
            RosterSays.LISTED -> when {
                evicted -> if ((evictedForMs ?: 0) >= EVICTED_GRACE_MS) Decision.Attest(rotate = true, "removed, and no re-add arrived")
                else Decision.Wait("removed; waiting for the re-add")
                rosterGroupId.isNullOrEmpty() -> Decision.Wait("the roster names no room yet")
                holdsRosterGroup(groups, rosterGroupId, coord) -> Decision.Wait("holding the roster's room")
                maybeInRoom(groups, coord) -> Decision.Wait("holding a group the coordinator sealed")
                // Listed, the room exists, and we hold nothing of it: the Welcome or our
                // state is gone. The key package it was for may be spent, so rotate.
                else -> Decision.Attest(rotate = true, "listed but holding no copy of the room")
            }
        }
    }

    /** We hold a copy of the roster's room that nobody but the coordinator (or an unknown welcomer) sealed. */
    fun holdsRosterGroup(groups: List<GroupBinding.GroupInfo>, rosterGroupId: String, coordinator: String): Boolean =
        groups.any { it.nostrGroupIdHex.equals(rosterGroupId, true) && (it.welcomer == null || it.welcomer.equals(coordinator, true)) }

    /** A group the coordinator sealed, joined or still a pending invitation: we may be in the room. */
    fun maybeInRoom(groups: List<GroupBinding.GroupInfo>, coordinator: String): Boolean =
        groups.any { it.welcomer.equals(coordinator, true) && (it.selfMember || it.pendingInvite) }

    /**
     * Offer "Rejoin" (revoke, rotate, add: a guaranteed visible kick) only on
     * positive eviction (K-6): removed and the grace ran out, removed and the roster
     * dropped us, or the coordinator refused this device. Never on elapsed setup time
     * or a failed send.
     */
    fun offerRejoin(phase: GroupBinding.Phase, evictedForMs: Long?, rosterSays: RosterSays, refused: Boolean): Boolean = when (phase) {
        GroupBinding.Phase.READY -> false
        GroupBinding.Phase.EVICTED -> (evictedForMs ?: 0) >= EVICTED_GRACE_MS || rosterSays == RosterSays.NOT_LISTED || refused
        GroupBinding.Phase.SETUP -> refused || rosterSays == RosterSays.NOT_LISTED
    }

    const val POLL_FAST_MS = 8_000L
    const val POLL_SLOW_MS = 60_000L
    /** How long the fast poll runs while not in the room before it backs off. */
    const val POLL_BACKOFF_AFTER_MS = 120_000L
    /** While polling, the roster is fetched again once it is this old. */
    const val POLL_ROSTER_MS = 24_000L

    /**
     * The not-READY poll (audit R-8): 8 s for the first two minutes out of the room,
     * then 60 s, for as long as the screen stays open. READY polls every 60 s.
     */
    fun pollDelayMs(ready: Boolean, notReadyForMs: Long): Long =
        if (ready || notReadyForMs >= POLL_BACKOFF_AFTER_MS) POLL_SLOW_MS else POLL_FAST_MS

    /**
     * Whether an MDK event is worth a reconcile (audit R-7: it used to run, re-reading
     * every group, on each incoming message). Group state and sync health always are.
     * A message is only while the room isn't bound yet (it may be the first sign of a
     * group just joined); once READY the open timeline renders messages by itself, and
     * membership changes arrive as state events (with the READY poll as a backstop).
     */
    fun needsReconcile(kind: ChatEngine.ChangeKind, ready: Boolean): Boolean = when (kind) {
        ChatEngine.ChangeKind.STATE, ChatEngine.ChangeKind.HEALTH -> true
        ChatEngine.ChangeKind.MESSAGE -> !ready
    }

    /** Whether an automatic attestation may go out now, [lastAttestMs] 0 meaning never this process. */
    fun attestAllowed(decision: Decision, lastAttestMs: Long, nowMs: Long, refusalRetry: Boolean): Boolean =
        decision is Decision.Attest && (refusalRetry || lastAttestMs == 0L || nowMs - lastAttestMs >= REATTEST_MIN_MS)
}
