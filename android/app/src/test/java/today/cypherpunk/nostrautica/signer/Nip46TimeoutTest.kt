package today.cypherpunk.nostrautica.signer

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.LocalSigner

/** Audit DS41-063: a signer that can't answer is an error the UI can show, not a silent cancellation. */
@RunWith(RobolectricTestRunner::class)
class Nip46TimeoutTest {
    @Test fun noReachableSignerRelayFailsFastWithAVisibleError() = runBlocking {
        val client = LocalSigner.generate()
        val signer = Nip46Signer.restore(
            RelayPool(RelayPool.newHttpClient()),
            Nip46Signer.Session(Bytes.toHex(client.secret()), "ab".repeat(32), "cd".repeat(32), listOf("ws://127.0.0.1:1")),
        )
        try {
            // The request timeout is 60 s; an unreachable relay must not cost that.
            withTimeout(20_000) { signer.nip44Encrypt("ef".repeat(32), "hi") }
            fail("expected SignerUnavailable")
        } catch (e: SignerUnavailable) {
            assertTrue(e.message!!.isNotBlank())
        } finally {
            signer.close()
        }
    }
}
