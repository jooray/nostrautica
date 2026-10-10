package today.cypherpunk.nostrautica.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class Nip49Test {
    // The NIP's prose gives 3501…4541 repeated for this vector, but its own reference
    // implementation (nostr-tools nip49) and every other decoder produce the value
    // below, which the authenticated ciphertext actually contains.
    @Test fun decryptsTheNipVector() {
        val sk = Nip49.decrypt(
            "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p",
            "nostr",
        )
        assertEquals("3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683", Bytes.toHex(sk))
    }

    @Test fun roundTripsAndRejectsWrongPassword() {
        val sk = Secp.generateSecret()
        val enc = Nip49.encrypt(sk, "correct horse", logN = 10)
        assertEquals(Bytes.toHex(sk), Bytes.toHex(Nip49.decrypt(enc, "correct horse")))
        assertThrows(IllegalArgumentException::class.java) { Nip49.decrypt(enc, "wrong") }
    }
}
