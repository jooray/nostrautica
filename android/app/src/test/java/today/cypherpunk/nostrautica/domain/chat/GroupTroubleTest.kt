package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Audit R-9: MDK stall/fork signals become "re-syncing", never Rejoin. */
class GroupTroubleTest {
    private val gid = "ab".repeat(32)

    @Test fun marksAreKeptPerGroupUntilCleared() {
        val t = GroupTrouble()
        t.mark(gid, GroupTrouble.STALLED)
        assertTrue(t.has(gid.uppercase(), GroupTrouble.STALLED))
        assertFalse(t.has("cd".repeat(32), GroupTrouble.STALLED))
        t.mark(gid, GroupTrouble.UNRECOVERABLE)
        t.clear(gid, GroupTrouble.STALLED, GroupTrouble.SUPERSEDED)
        assertFalse(t.has(gid, GroupTrouble.STALLED))
        assertTrue(t.has(gid, GroupTrouble.UNRECOVERABLE))
    }

    @Test fun onlyAReissuedSupersededChangeNeedsNothing() {
        assertFalse(GroupTrouble.supersededNeedsAttention("reissued"))
        for (o in listOf("conflict", "already_satisfied", "reinvite_required", "abandoned", "not_member")) {
            assertTrue(o, GroupTrouble.supersededNeedsAttention(o))
        }
    }

    @Test fun everySignalMeansResyncing() {
        assertFalse(ChatEngine.SyncHealth().resyncing)
        assertTrue(ChatEngine.SyncHealth(stalled = true).resyncing)
        assertTrue(ChatEngine.SyncHealth(superseded = true).resyncing)
        assertTrue(ChatEngine.SyncHealth(unrecoverable = true).resyncing)
        assertTrue(ChatEngine.SyncHealth(automaticRecoveryFailed = true).resyncing)
        assertTrue(ChatEngine.SyncHealth(historyMayBeIncomplete = true).resyncing)
    }

    @Test fun anUnrecoverableCopyWeStillHoldIsNotEviction() {
        // A frozen copy with our leaf in it stays READY (re-syncing), not EVICTED.
        val g = GroupBinding.GroupInfo("mls", gid, "c".repeat(64), listOf("c".repeat(64)), selfMember = true, pendingInvite = false, unrecoverable = true)
        assertTrue(GroupBinding.phase(GroupBinding.select(listOf(g), gid, "c".repeat(64))) == GroupBinding.Phase.READY)
        assertFalse(ChatPolicy.offerRejoin(GroupBinding.Phase.READY, null, ChatPolicy.RosterSays.LISTED, refused = false))
    }
}
