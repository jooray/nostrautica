package today.cypherpunk.nostrautica.nostr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.signer.Nip46Signer

/** Audit R-66/R-78: one relay acceptance rule (relays.ts isAcceptedRelayUrl) at every peer-controlled source. */
class RelayAcceptanceTest {
    @Test fun wssOrLoopbackWsOnly() {
        assertTrue(Relays.isAccepted("wss://relay.example"))
        assertTrue(Relays.isAccepted("ws://localhost:7777"))
        assertTrue(Relays.isAccepted("ws://127.0.0.1:7777"))
        assertTrue(Relays.isAccepted("ws://[::1]:7777"))
        assertFalse(Relays.isAccepted("ws://attacker.example"))
        assertFalse(Relays.isAccepted("ws://192.168.1.10:7777"))
        assertFalse(Relays.isAccepted("https://relay.example"))
        assertFalse(Relays.isAccepted("wss://"))
        assertFalse(Relays.isAccepted("not a url"))
    }

    @Test fun anNaddrHintNamingPlaintextRemoteIsDropped() {
        val relays = Relays.forEvent(null, listOf("ws://attacker.example", "wss://good.example/", "relay.bare.example"))
        assertFalse(relays.any { "attacker" in it })
        assertTrue("wss://good.example" in relays)
        assertTrue("wss://relay.bare.example" in relays)
        assertTrue(relays.containsAll(Relays.DEFAULT.map(RelayPool::normalize)))
    }

    @Test fun aBunkerPointerCannotAddAPlaintextRemoteRelay() {
        val relays = Nip46Signer.relaysWith(listOf("ws://attacker.example", "wss://bunker.example"))
        assertFalse(relays.any { "attacker" in it })
        assertTrue("wss://bunker.example" in relays)
        assertEquals(Relays.NIP46.map(RelayPool::normalize), relays.take(Relays.NIP46.size))
    }
}
