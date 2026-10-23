package today.cypherpunk.nostrautica.signer

import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.WebSocket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.nostr.FakeRelay
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import java.util.concurrent.CompletableFuture

/** Audit R-77: a bunker's `auth_url` challenge reaches the UI and clears when the call settles. */
@RunWith(RobolectricTestRunner::class)
class Nip46AuthUrlTest {
    private val relay = FakeRelay()
    private val bunker = LocalSigner.generate()
    private val client = LocalSigner.generate()
    @Volatile private var sub: Pair<WebSocket, String>? = null
    private val request = CompletableFuture<Pair<String, String>>() // request id, client pubkey

    @After fun down() { relay.close(); Nip46Approvals.dismiss() }

    private fun send(to: String, body: String) = runBlocking {
        val ev = bunker.signNow(bunker.template(Kinds.NIP46, bunker.nip44Encrypt(to, body), listOf(listOf("p", to))))
        val (ws, sid) = sub!!
        ws.send("""["EVENT",${JsJson.quote(sid)},${ev.toJsonString()}]""")
    }

    @Test fun anAuthUrlIsShownUntilTheRealReplyArrives() = runBlocking {
        relay.onReq = { ws, id, _ -> sub = ws to id; ws.send("""["EOSE",${JsJson.quote(id)}]""") }
        relay.onEvent = { ws, e ->
            ws.send("""["OK","${e.id}",true,""]""")
            if (e.kind == Kinds.NIP46) runBlocking {
                val req = Json.parseToJsonElement(bunker.nip44Decrypt(e.pubkey, e.content)) as JsonObject
                val id = req["id"]!!.jsonPrimitive.content
                send(e.pubkey, JsJson.stringify(buildJsonObject { put("id", id); put("result", "auth_url"); put("error", "https://bunker.example/approve?r=$id") }))
                request.complete(id to e.pubkey)
            }
        }
        val signer = Nip46Signer.restore(
            RelayPool(RelayPool.newHttpClient()),
            Nip46Signer.Session(Bytes.toHex(client.secret()), bunker.pubkey, bunker.pubkey, listOf(relay.url)),
        )
        try {
            val call = async(kotlinx.coroutines.Dispatchers.IO) { signer.nip44Encrypt("ef".repeat(32), "hi") }
            val url = withTimeout(15_000) { Nip46Approvals.url.first { it != null } }
            val (id, to) = request.get()
            assertEquals("https://bunker.example/approve?r=$id", url)
            // The user approved: the bunker answers the same id.
            send(to, JsJson.stringify(buildJsonObject { put("id", id); put("result", "sealed") }))
            assertEquals("sealed", withTimeout(15_000) { call.await() })
            assertNull(Nip46Approvals.url.value)
        } finally {
            signer.close()
        }
    }

    @Test fun onlyAnHttpsLinkWithoutUserinfoIsShown() {
        assertEquals("https://signer.example/approve?id=1", Nip46Approvals.safeAuthUrl("https://signer.example/approve?id=1"))
        assertNull(Nip46Approvals.safeAuthUrl("http://signer.example/approve"))
        assertNull(Nip46Approvals.safeAuthUrl("javascript:alert(1)"))
        assertNull(Nip46Approvals.safeAuthUrl("intent://x#Intent;scheme=https;end"))
        assertNull(Nip46Approvals.safeAuthUrl("https://user:pass@signer.example/approve"))
        assertNull(Nip46Approvals.safeAuthUrl("https:///nohost"))
        assertNull(Nip46Approvals.safeAuthUrl("not a url"))
    }

    @Test fun settlingOneRequestKeepsAnotherWaiting() {
        Nip46Approvals.open("a", "https://x.example/a")
        Nip46Approvals.open("b", "https://x.example/b")
        Nip46Approvals.settle("b")
        assertEquals("https://x.example/a", Nip46Approvals.url.value)
        Nip46Approvals.settle("a")
        assertNull(Nip46Approvals.url.value)
    }
}
