package today.cypherpunk.nostrautica.signer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.WebSocket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.nostr.FakeRelay
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner

/** Audit SB-19: a restored NIP-46 session is checked against who the bunker signs for now. */
@RunWith(RobolectricTestRunner::class)
class Nip46RestoreIdentityTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val relay = FakeRelay()
    private val bunker = LocalSigner.generate()
    private val client = LocalSigner.generate()
    private val storedUser = LocalSigner.generate().pubkey
    @Volatile private var sub: Pair<WebSocket, String>? = null

    @After fun down() = relay.close()

    /** A bunker on [relay] that answers get_public_key with [answer]. */
    private fun bunkerAnswers(answer: String) {
        relay.onReq = { ws, id, _ -> sub = ws to id; ws.send("""["EOSE",${JsJson.quote(id)}]""") }
        relay.onEvent = { ws, e ->
            ws.send("""["OK","${e.id}",true,""]""")
            if (e.kind == Kinds.NIP46) runBlocking {
                val req = Json.parseToJsonElement(bunker.nip44Decrypt(e.pubkey, e.content)) as JsonObject
                val body = JsJson.stringify(buildJsonObject { put("id", req["id"]!!.jsonPrimitive.content); put("result", answer) })
                val reply = bunker.signNow(bunker.template(Kinds.NIP46, bunker.nip44Encrypt(e.pubkey, body), listOf(listOf("p", e.pubkey))))
                val (sw, sid) = sub!!
                sw.send("""["EVENT",${JsJson.quote(sid)},${reply.toJsonString()}]""")
            }
        }
    }

    private fun restoredSession(): Session {
        val secure = MemorySecureStore(ctx)
        secure.map["account"] = """{"method":"nip46","pubkey":"$storedUser","nip46":{"clientSk":"${Bytes.toHex(client.secret())}","signerPubkey":"${bunker.pubkey}","userPubkey":"$storedUser","relays":["${relay.url}"]}}"""
        return Session(ctx, secure, RelayPool(RelayPool.newHttpClient()), SignerIntentBridge()).also { it.restore() }
    }

    @Test fun aBunkerThatNowSignsForSomeoneElseSignsTheAccountOut() = runBlocking {
        bunkerAnswers(LocalSigner.generate().pubkey)
        val session = restoredSession()
        assertEquals(storedUser, session.account.value?.pubkey)
        assertFalse(session.verifyRestoredSigner())
        assertNull(session.account.value)
    }

    @Test fun theSameUserKeepsTheSession() = runBlocking {
        bunkerAnswers(storedUser)
        val session = restoredSession()
        assertTrue(session.verifyRestoredSigner())
        assertEquals(storedUser, session.account.value?.pubkey)
    }
}
