package today.cypherpunk.nostrautica.domain.join

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Audit R-27: a deep-linked invite code belongs to the account that opened it. */
class InviteCodesTest {
    private val coord = "31923:" + "ab".repeat(32) + ":ev"

    @Test fun theNextAccountDoesNotRedeemTheLastOnesCode() {
        val codes = InviteCodes()
        codes.store("alice", coord, "nsec-alice")
        assertNull(codes.load("bob", coord))
        assertEquals("nsec-alice", codes.load("alice", coord))
        codes.forget("alice")
        assertNull(codes.load("alice", coord))
    }

    @Test fun aCodeOpenedSignedOutGoesToWhoeverJoinsWithItThenIsGone() {
        val codes = InviteCodes()
        codes.store(null, coord, "nsec-link")
        assertEquals("nsec-link", codes.load(null, coord))
        assertEquals("nsec-link", codes.load("new-account", coord))
        codes.clear("new-account", coord)
        assertNull(codes.load("someone-else", coord))
    }

    @Test fun aLogoutAlsoDropsUnclaimedSignedOutCodes() {
        val codes = InviteCodes()
        codes.store(null, coord, "nsec-link")
        codes.forget("alice")
        assertNull(codes.load("bob", coord))
    }
}
