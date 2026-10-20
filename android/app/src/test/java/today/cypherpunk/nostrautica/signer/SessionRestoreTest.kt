package today.cypherpunk.nostrautica.signer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.LocalSigner

/** In-memory stand-in for the Keystore-backed store (Robolectric has no AndroidKeyStore). */
class MemorySecureStore(context: Context) : SecureStore(context) {
    val map = HashMap<String, String>()
    override fun put(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
    override fun get(name: String): String? = map[name]
}

@RunWith(RobolectricTestRunner::class)
class SessionRestoreTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val secure = MemorySecureStore(ctx)
    private val session = Session(ctx, secure, RelayPool(RelayPool.newHttpClient()), SignerIntentBridge())

    @Test fun aStoredLocalKeyRestores() {
        val s = LocalSigner.generate()
        secure.map["account"] = """{"method":"local","pubkey":"${s.pubkey}","localSk":"${Bytes.toHex(s.secret())}"}"""
        session.restore()
        assertEquals(s.pubkey, session.account.value?.pubkey)
    }

    // Audit SB-20: each of these threw out of Application.onCreate on every launch.
    @Test fun aBlobThatNoLongerBuildsASignerStartsSignedOutInsteadOfCrashing() {
        val bad = listOf(
            """{"method":"local","pubkey":"${"ab".repeat(32)}","localSk":"not hex"}""",
            """{"method":"local","pubkey":"${"ab".repeat(32)}","localSk":"${"00".repeat(32)}"}""",
            """{"method":"nip55","pubkey":"zz","signerPackage":"com.greenart7c3.nostrsigner"}""",
            """{"method":"nip46","pubkey":"${"ab".repeat(32)}","nip46":{"clientSk":"xyz","signerPubkey":"a","userPubkey":"b","relays":[]}}""",
        )
        for (blob in bad) {
            secure.map.clear()
            secure.map["account"] = blob
            session.restore()
            assertNull(session.account.value)
            assertNull("the broken blob no longer sits under the live key", secure.map["account"])
            assertNotNull("but it is kept aside, not destroyed", secure.map["account.unreadable"])
        }
    }
}
