package today.cypherpunk.nostrautica.signer

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `nostrconnect://` acceptance rule (audit SB-05). */
class Nip46HandshakeTest {
    private val secret = "0123456789abcdef0123456789abcdef"
    private fun msg(s: String) = Json.parseToJsonElement(s) as JsonObject

    @Test fun theOffersSecretCompletesTheHandshake() {
        assertTrue(Nip46Signer.acceptsNostrConnect(msg("""{"id":"x","result":"$secret"}"""), secret))
    }

    @Test fun aBareAckIsNotProofOfHavingSeenTheCode() {
        // Anyone who saw our REQ knows the client pubkey and can encrypt this to it.
        assertFalse(Nip46Signer.acceptsNostrConnect(msg("""{"id":"x","result":"ack"}"""), secret))
    }

    @Test fun anythingElseIsRejected() {
        assertFalse(Nip46Signer.acceptsNostrConnect(msg("""{"id":"x","result":"${secret}0"}"""), secret))
        assertFalse(Nip46Signer.acceptsNostrConnect(msg("""{"id":"x","error":"$secret"}"""), secret))
        assertFalse(Nip46Signer.acceptsNostrConnect(msg("""{"id":"x","result":null}"""), secret))
        assertFalse(Nip46Signer.acceptsNostrConnect(msg("""{"id":"x","result":""}"""), ""))
    }
}
