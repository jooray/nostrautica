package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.chat.ChatPolicy.Decision
import today.cypherpunk.nostrautica.domain.chat.ChatPolicy.RosterSays
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterChatKey
import today.cypherpunk.nostrautica.protocol.RosterContent

/** Audit K-4: attest only on positive evidence of being out of the room. */
class ChatPolicyTest {
    private val coord = "c".repeat(64)
    private val account = "a".repeat(64)
    private val me = "d".repeat(64)
    private val gid = "a1".repeat(32)

    private fun g(
        nostrId: String = gid, welcomer: String? = coord, members: List<String>? = listOf(coord, me),
        self: Boolean = true, pending: Boolean = false, id: String = "mls-" + nostrId.take(4),
    ) = GroupBinding.GroupInfo(id, nostrId, welcomer, members, self, pending)

    private fun roster(keys: List<String>, groupId: String? = gid, others: Boolean = true) = RosterContent(
        2, 1, groupId, null,
        listOf(RosterAttendee(account, "d", "attendee", keys.map { RosterChatKey(it, null, 1) })) +
            if (others) listOf(RosterAttendee("b".repeat(64), "d2", "attendee")) else emptyList(),
    )

    private fun decide(
        groups: List<GroupBinding.GroupInfo>?,
        says: RosterSays,
        rosterGid: String? = gid,
        evictedFor: Long? = null,
        refusal: Boolean = false,
    ): Decision {
        val binding = GroupBinding.select(groups.orEmpty(), rosterGid, coord)
        return ChatPolicy.decide(groups, binding, says, rosterGid, coord, evictedFor, refusal)
    }

    @Test fun rosterSaysNeedsAFreshRosterWithAttendees() {
        assertEquals(RosterSays.LISTED, ChatPolicy.rosterSays(roster(listOf(me)), true, account, me))
        assertEquals(RosterSays.NOT_LISTED, ChatPolicy.rosterSays(roster(emptyList()), true, account, me))
        // A cached (not fresh) roster is no evidence either way.
        assertEquals(RosterSays.UNKNOWN, ChatPolicy.rosterSays(roster(emptyList()), false, account, me))
        // The roster fetch's "no relay had it" placeholder has no attendees.
        assertEquals(RosterSays.UNKNOWN, ChatPolicy.rosterSays(RosterContent(2, 1, null, null, emptyList()), true, account, me))
        assertEquals(RosterSays.UNKNOWN, ChatPolicy.rosterSays(null, true, account, me))
        assertEquals(RosterSays.LISTED, ChatPolicy.rosterSays(roster(listOf(me.uppercase())), true, account, me))
    }

    @Test fun inTheRoomNeverAttests() {
        assertTrue(decide(listOf(g()), RosterSays.NOT_LISTED) is Decision.Wait)
        assertTrue(decide(listOf(g()), RosterSays.NOT_LISTED, refusal = true) is Decision.Wait)
    }

    @Test fun unreadableGroupsNeverAttest() {
        assertTrue(decide(null, RosterSays.NOT_LISTED) is Decision.Wait)
        assertTrue(decide(null, RosterSays.LISTED, refusal = true) is Decision.Wait)
    }

    @Test fun unknownRosterWaitsWhateverTheGroupsSay() {
        assertTrue(decide(emptyList(), RosterSays.UNKNOWN) is Decision.Wait)
        assertTrue(decide(listOf(g(self = false)), RosterSays.UNKNOWN, evictedFor = 10 * 60_000L) is Decision.Wait)
    }

    @Test fun aFreshRosterWithoutOurKeyAttests() {
        val d = decide(emptyList(), RosterSays.NOT_LISTED)
        assertEquals(Decision.Attest(rotate = false, d.why), d)
        // Removed and dropped from the roster (a revoke): attest now, with a new key package.
        val evicted = decide(listOf(g(self = false)), RosterSays.NOT_LISTED, evictedFor = 1_000L)
        assertEquals(true, (evicted as Decision.Attest).rotate)
    }

    @Test fun evictedWaitsForTheReAddWhileTheRosterListsUs() {
        // A-1: the re-add Welcome arrives after the removing commit; attesting before it
        // makes the coordinator evict and re-add again.
        assertTrue(decide(listOf(g(self = false)), RosterSays.LISTED, evictedFor = 0L) is Decision.Wait)
        assertTrue(decide(listOf(g(self = false)), RosterSays.LISTED, evictedFor = ChatPolicy.EVICTED_GRACE_MS - 1) is Decision.Wait)
        val after = decide(listOf(g(self = false)), RosterSays.LISTED, evictedFor = ChatPolicy.EVICTED_GRACE_MS)
        assertEquals(true, (after as Decision.Attest).rotate)
    }

    @Test fun listedAndHoldingTheRoomInAnyFormWaits() {
        // Unconfirmed (member list unreadable or empty: A-2).
        assertTrue(decide(listOf(g(members = null)), RosterSays.LISTED) is Decision.Wait)
        assertTrue(decide(listOf(g(members = emptyList())), RosterSays.LISTED) is Decision.Wait)
        // Welcomer unknown after an MDK projection rebuild.
        assertTrue(decide(listOf(g(welcomer = null, members = null)), RosterSays.LISTED) is Decision.Wait)
        // Coordinator readable but not (yet) a member.
        assertTrue(decide(listOf(g(members = listOf(me))), RosterSays.LISTED) is Decision.Wait)
    }

    @Test fun aCoordinatorSealedGroupCountsAsMaybeInTheRoom() {
        // A-5: a pending invitation the coordinator sealed, under an id the roster doesn't name.
        val pending = g(nostrId = "b2".repeat(32), pending = true)
        assertTrue(decide(listOf(pending), RosterSays.LISTED) is Decision.Wait)
        val joined = g(nostrId = "b2".repeat(32))
        assertTrue(decide(listOf(joined), RosterSays.LISTED) is Decision.Wait)
        // A group someone else sealed is not ours to wait on.
        val foreign = g(nostrId = "b2".repeat(32), welcomer = "f".repeat(64))
        assertEquals(true, (decide(listOf(foreign), RosterSays.LISTED) as Decision.Attest).rotate)
    }

    @Test fun listedButNoRoomNamedWaits() {
        assertTrue(decide(emptyList(), RosterSays.LISTED, rosterGid = null) is Decision.Wait)
    }

    @Test fun listedHoldingNothingAttestsWithAFreshKeyPackage() {
        assertEquals(true, (decide(emptyList(), RosterSays.LISTED) as Decision.Attest).rotate)
    }

    /** NIP §10.2 intent (0.18): only a removal whose re-add never came is a rejoin. */
    @Test fun onlyAnEvictionPastTheGraceSendsRejoin() {
        val enrol = ChatAttest.Intent.ENROL
        val rejoin = ChatAttest.Intent.REJOIN
        fun intent(d: Decision) = (d as Decision.Attest).intent
        // Removed, the roster still lists us, and no re-add arrived: our leaf is gone.
        assertEquals(rejoin, intent(decide(listOf(g(self = false)), RosterSays.LISTED, evictedFor = ChatPolicy.EVICTED_GRACE_MS)))
        // First enrolment: the roster does not list this device yet.
        assertEquals(enrol, intent(decide(emptyList(), RosterSays.NOT_LISTED)))
        // Removed AND dropped from the roster (a revoke): the coordinator holds no leaf to replace.
        assertEquals(enrol, intent(decide(listOf(g(self = false)), RosterSays.NOT_LISTED, evictedFor = 1_000L)))
        // Listed, holding nothing of the room (a lost Welcome, never added from our side).
        assertEquals(enrol, intent(decide(emptyList(), RosterSays.LISTED)))
        // A group someone else sealed.
        assertEquals(enrol, intent(decide(listOf(g(nostrId = "b2".repeat(32), welcomer = "f".repeat(64))), RosterSays.LISTED)))
        // A fixable refusal's one retry.
        assertEquals(enrol, intent(decide(listOf(g(members = null)), RosterSays.UNKNOWN, refusal = true)))
        // An enrolment is the default, so no other path can turn into a rejoin by omission.
        assertEquals(enrol, Decision.Attest(rotate = true, "x").intent)
    }

    @Test fun aFixableRefusalAttestsOnceMore() {
        assertTrue(decide(listOf(g(members = null)), RosterSays.UNKNOWN, refusal = true) is Decision.Attest)
    }

    @Test fun rejoinIsOfferedOnlyOnPositiveEviction() {
        val ev = GroupBinding.Phase.EVICTED
        val setup = GroupBinding.Phase.SETUP
        // K-6: never on elapsed setup time alone, never while in the room.
        assertFalse(ChatPolicy.offerRejoin(setup, null, RosterSays.UNKNOWN, refused = false))
        assertFalse(ChatPolicy.offerRejoin(setup, null, RosterSays.LISTED, refused = false))
        assertFalse(ChatPolicy.offerRejoin(GroupBinding.Phase.READY, null, RosterSays.NOT_LISTED, refused = true))
        // Removed: not during the re-add grace, unless the roster dropped us.
        assertFalse(ChatPolicy.offerRejoin(ev, 1_000L, RosterSays.LISTED, refused = false))
        assertFalse(ChatPolicy.offerRejoin(ev, 1_000L, RosterSays.UNKNOWN, refused = false))
        assertTrue(ChatPolicy.offerRejoin(ev, ChatPolicy.EVICTED_GRACE_MS, RosterSays.LISTED, refused = false))
        assertTrue(ChatPolicy.offerRejoin(ev, 1_000L, RosterSays.NOT_LISTED, refused = false))
        // The coordinator refused this device, or the roster no longer lists it.
        assertTrue(ChatPolicy.offerRejoin(setup, null, RosterSays.UNKNOWN, refused = true))
        assertTrue(ChatPolicy.offerRejoin(setup, null, RosterSays.NOT_LISTED, refused = false))
    }

    @Test fun messagesInARoomAlreadyOpenDoNotReconcile() {
        // R-7: no full group re-read per message once the room is bound.
        assertFalse(ChatPolicy.needsReconcile(ChatEngine.ChangeKind.MESSAGE, ready = true))
        assertTrue(ChatPolicy.needsReconcile(ChatEngine.ChangeKind.MESSAGE, ready = false))
        assertTrue(ChatPolicy.needsReconcile(ChatEngine.ChangeKind.STATE, ready = true))
        assertTrue(ChatPolicy.needsReconcile(ChatEngine.ChangeKind.HEALTH, ready = true))
    }

    @Test fun theSetupPollBacksOffAfterTwoMinutes() {
        assertEquals(8_000L, ChatPolicy.pollDelayMs(ready = false, notReadyForMs = 0))
        assertEquals(8_000L, ChatPolicy.pollDelayMs(ready = false, notReadyForMs = 119_999))
        assertEquals(60_000L, ChatPolicy.pollDelayMs(ready = false, notReadyForMs = 120_000))
        assertEquals(60_000L, ChatPolicy.pollDelayMs(ready = true, notReadyForMs = 0))
    }

    @Test fun automaticAttestationsAreSpacedOut() {
        val attest = Decision.Attest(false, "x")
        assertTrue(ChatPolicy.attestAllowed(attest, 0L, 1_000L, false))
        assertFalse(ChatPolicy.attestAllowed(attest, 1_000L, 2_000L, false))
        assertTrue(ChatPolicy.attestAllowed(attest, 1_000L, 2_000L, true))
        assertTrue(ChatPolicy.attestAllowed(attest, 1_000L, 1_000L + ChatPolicy.REATTEST_MIN_MS, false))
        assertFalse(ChatPolicy.attestAllowed(Decision.Wait("x"), 0L, 1_000L, true))
    }
}
