package today.cypherpunk.nostrautica.domain.join

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.media.UserFacingError
import today.cypherpunk.nostrautica.protocol.JoinRequestContent
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.Wire

class JoinRulesTest {
    @Test fun pollCadence() {
        assertEquals(1_500, JoinRules.pollGapMs(0, 10, 0))
        assertEquals(1_500, JoinRules.pollGapMs(9, 10, 0))
        assertEquals(5_000, JoinRules.pollGapMs(10, 10, 60_000))
        assertEquals(5_000, JoinRules.pollGapMs(0, 0, 0))
        assertEquals(60_000, JoinRules.pollGapMs(20, 0, JoinRules.POLL_RELAX_AFTER_MS + 1))
    }

    @Test fun landing() {
        assertEquals(JoinLanding.APPROVED, JoinRules.landing(approved = true, joinSent = true, hasInvite = true))
        assertEquals(JoinLanding.WAITING, JoinRules.landing(approved = false, joinSent = true, hasInvite = false))
        // An unspent invite in hand outranks the "already asked" marker.
        assertEquals(JoinLanding.FORM, JoinRules.landing(approved = false, joinSent = true, hasInvite = true))
        assertEquals(JoinLanding.FORM, JoinRules.landing(approved = false, joinSent = false, hasInvite = false))
    }

    @Test fun profileLoadIsNeverConfusedWithEmpty() {
        assertEquals(ProfileLoadState.FAILED, JoinRules.classifyProfile("Alice", "bio", null, failed = true).state)
        assertEquals(ProfileLoadState.LOADED, JoinRules.classifyProfile(" Alice ", null, null, failed = false).state)
        assertEquals("Alice", JoinRules.classifyProfile(" Alice ", null, null, failed = false).name)
        assertEquals(ProfileLoadState.LOADED, JoinRules.classifyProfile(null, "bio only", null, failed = false).state)
        assertEquals(ProfileLoadState.EMPTY, JoinRules.classifyProfile(" ", "", null, failed = false).state)
    }

    @Test fun submitGate() {
        assertTrue(JoinRules.canSubmitLoggedIn(ProfileLoadState.LOADED, ""))
        assertFalse(JoinRules.canSubmitLoggedIn(ProfileLoadState.EMPTY, "  "))
        assertTrue(JoinRules.canSubmitLoggedIn(ProfileLoadState.FAILED, "Bob"))
        assertFalse(JoinRules.canSubmitLoggedIn(ProfileLoadState.LOADING, "Bob"))
        assertFalse(JoinRules.canSubmitLoggedIn(ProfileLoadState.IDLE, "Bob"))
    }

    @Test fun inviteTagIsAValidProofBoundToTheAttendee() {
        val inviteSk = Secp.generateSecret()
        val attendee = Secp.pubkeyHex(Secp.generateSecret())
        val coordinate = "31923:${"b".repeat(64)}:meetup"
        val tag = JoinRules.inviteTag(Nip19.nsec(inviteSk), coordinate, attendee)
        assertEquals("invite", tag[0])
        assertEquals(Secp.pubkeyHex(inviteSk), tag[1])
        assertTrue(ProtocolCrypto.verifyInviteProof(ProtocolCrypto.InviteProof(tag[1], tag[2]), coordinate, attendee))
        assertFalse(ProtocolCrypto.verifyInviteProof(ProtocolCrypto.InviteProof(tag[1], tag[2]), coordinate, Secp.pubkeyHex(Secp.generateSecret())))
    }

    @Test fun badInviteCodeIsAUserFacingError() {
        val e = assertThrows(UserFacingError::class.java) { JoinRules.inviteSecret("not-a-code") }
        assertEquals("error.inviteCode", e.key)
    }

    @Test fun joinContentIsBoundedAndSchemaValid() {
        val c = JoinRules.joinContent("x".repeat(500), "m".repeat(5000), rsvpPublic = true)
        assertEquals(Limits.MAX_NAME, c.name.length)
        assertEquals(Limits.MAX_MESSAGE, c.message.length)
        val json = Wire.encode(JoinRequestContent.serializer(), c)
        assertTrue(json.contains("\"v\":2"))
        assertTrue(json.contains("\"rsvp_public\":true"))
    }

    @Test fun talkEditDraftRoundTrips() {
        val d = TalkEditDraft("abcd", "Title", "Desc", 3)
        assertTrue(JoinFlow.encodeTalkEdit(d).startsWith("{"))
        assertEquals(16, JoinFlow.newTalkId().length)
    }
}
