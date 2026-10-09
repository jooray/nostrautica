package today.cypherpunk.nostrautica.domain.chat

/**
 * Event → MLS group routing (NIP §10.4; chat/client.ts resolveEventGroups).
 *
 * A Welcome carries no event coordinate, and two chat events can share one
 * coordinator, so the only authority for "this is the event's room" is the
 * roster's `nostr_group_id` (ECK-encrypted, published by the coordinator). A group
 * is bound ONLY when its Nostr group id equals that value; with no roster id at
 * all the binding fails closed and the chat stays "setting up" rather than guess.
 *
 * Defence in depth on top (audit APPK-2): the group's welcomer, when MDK knows it,
 * must be the event's coordinator, and the coordinator must hold a leaf in it.
 */
object GroupBinding {
    /** What MDK tells us about one local group, reduced to what the decision needs. */
    data class GroupInfo(
        val groupIdHex: String,
        val nostrGroupIdHex: String,
        /** Account that sealed the Welcome, when known. */
        val welcomer: String?,
        /** Device keys holding a leaf, when the member list could be read. */
        val members: List<String>?,
        /** Our own leaf is in the group (MDK `selfMembership == MEMBER`). */
        val selfMember: Boolean,
        /** MDK still shows it as an unconfirmed invitation. */
        val pendingInvite: Boolean,
    )

    sealed interface Result {
        /** No roster id to verify against: refuse to route (fail closed). */
        data object Unverified : Result
        /** The roster names a group we do not hold (not added yet). */
        data object NotJoined : Result
        data class Bound(val group: GroupInfo) : Result
    }

    fun select(groups: List<GroupInfo>, rosterGroupId: String?, coordinator: String?): Result {
        val want = rosterGroupId?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Result.Unverified
        val candidates = groups.filter { g ->
            g.nostrGroupIdHex.lowercase() == want &&
                (coordinator == null || g.welcomer == null || g.welcomer == coordinator) &&
                (coordinator == null || g.members == null || coordinator in g.members)
        }
        // Removed and re-added leaves two states under one id; route to the live one.
        val pick = candidates.firstOrNull { it.selfMember } ?: candidates.firstOrNull() ?: return Result.NotJoined
        return Result.Bound(pick)
    }

    enum class Phase { SETUP, READY, EVICTED }

    fun phase(r: Result): Phase = when (r) {
        is Result.Bound -> if (r.group.selfMember) Phase.READY else Phase.EVICTED
        else -> Phase.SETUP
    }

    /** Pending invitations it is safe to accept: sealed by this event's coordinator. */
    fun acceptable(groups: List<GroupInfo>, coordinator: String?): List<GroupInfo> =
        if (coordinator == null) emptyList() else groups.filter { it.pendingInvite && it.welcomer == coordinator }
}
