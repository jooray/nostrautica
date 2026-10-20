package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeFreshnessTest {
    @Test fun aFreshRuntimeNeverRestarts() {
        assertFalse(RuntimeFreshness().shouldRestart(1))
    }

    @Test fun aGroupJoinedMidRunAsksForOneRestart() {
        val f = RuntimeFreshness()
        f.joinedGroup("AB".repeat(32))
        assertTrue(f.shouldRestart(1))
        f.restarted()
        assertFalse("the restart registered the group; it must not restart again", f.shouldRestart(1))
    }

    @Test fun aRelayListChangeAsksForARestart() {
        val f = RuntimeFreshness()
        f.relayListsChanged()
        assertTrue(f.shouldRestart(1))
        f.restarted()
        assertFalse(f.shouldRestart(1))
    }

    @Test fun neverRestartsUnderAnotherHolderAndStaysStaleUntilALoneOne() {
        val f = RuntimeFreshness()
        f.joinedGroup("ab".repeat(32))
        assertFalse(f.shouldRestart(2))
        assertFalse(f.shouldRestart(0))
        assertTrue(f.shouldRestart(1))
    }

    @Test fun aRejoinAfterARestartAsksAgain() {
        val f = RuntimeFreshness()
        f.joinedGroup("ab".repeat(32))
        f.restarted()
        f.joinedGroup("ab".repeat(32))
        assertTrue(f.shouldRestart(1))
    }
}
