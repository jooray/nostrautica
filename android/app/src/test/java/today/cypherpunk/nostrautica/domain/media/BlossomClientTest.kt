package today.cypherpunk.nostrautica.domain.media

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.jsonObjectOf

class BlossomClientTest {
    private val signer = LocalSigner.generate()
    private lateinit var a: MockWebServer
    private lateinit var b: MockWebServer

    @Before fun up() { a = MockWebServer().also { it.start() }; b = MockWebServer().also { it.start() } }
    @After fun down() { a.close(); b.close() }

    private fun base(s: MockWebServer) = s.url("/").toString().trimEnd('/')

    private fun authOf(header: String?): NostrEvent {
        assertNotNull(header)
        assertTrue(header!!.startsWith("Nostr "))
        return NostrEvent.fromJsonString(String(Bytes.fromBase64(header.removePrefix("Nostr ")))).also { assertNotNull(it) }!!
    }

    @Test fun authEventShape() {
        val t = BlossomAuth.template(signer.pubkey, BlossomAuth.Verb.UPLOAD, "ab".repeat(32), now = 1000)
        assertEquals(Kinds.BLOSSOM_AUTH, t.kind)
        assertEquals(listOf(listOf("t", "upload"), listOf("x", "ab".repeat(32)), listOf("expiration", "4600")), t.tags)
        assertEquals("", t.content)
        val ev = runBlocking { BlossomAuth.build(signer, BlossomAuth.Verb.DELETE, "cd".repeat(32)) }
        assertTrue(ev.verify())
        assertEquals(ev, authOf(BlossomAuth.header(ev)))
    }

    @Test fun uploadPutsBytesWithAuthAndKeepsOnlyOurUrl() = runBlocking {
        val bytes = Bytes.random(200_000)
        val sha = Bytes.sha256Hex(bytes)
        a.enqueue(MockResponse.Builder().code(200).body("""{"url":"https://evil.example/other"}""").build())
        val progress = mutableListOf<Long>()
        val url = BlossomClient(OkHttpClient()).upload(signer, base(a), bytes, "application/octet-stream") { progress += it.sent }
        // A descriptor URL that doesn't carry our hash is not trusted (MED-9).
        assertEquals("${base(a)}/$sha", url)
        val req = a.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/upload", req.url.encodedPath)
        assertEquals(bytes.size.toLong(), req.body?.size?.toLong())
        val auth = authOf(req.headers["Authorization"])
        assertEquals("upload", auth.tag("t"))
        assertEquals(sha, auth.tag("x"))
        assertTrue(auth.verify())
        assertEquals(0L, progress.first())
        assertEquals(bytes.size.toLong(), progress.last())
    }

    @Test fun uploadFallsThroughToTheNextServerAndMirrors() = runBlocking {
        val bytes = Bytes.random(1000)
        val sha = Bytes.sha256Hex(bytes)
        a.enqueue(MockResponse.Builder().code(415).addHeader("X-Reason", "no ciphertext").build())
        b.enqueue(MockResponse.Builder().code(200).body("{}").build())
        val client = BlossomClient(OkHttpClient())
        val r = client.uploadAndMirror(signer, listOf(base(a), base(b)), bytes, "application/octet-stream")
        assertEquals("${base(b)}/$sha", r.primary)
        assertEquals(listOf(r.primary), r.urls)
        // One signature for the blob, reused across servers (one Amber prompt, not one per server).
        assertEquals(authOf(a.takeRequest().headers["Authorization"]).id, authOf(b.takeRequest().headers["Authorization"]).id)
        assertEquals(null, client.progress.value)
    }

    @Test fun mirrorAndPreflight() = runBlocking {
        val client = BlossomClient(OkHttpClient())
        val sha = "aa".repeat(32)
        a.enqueue(MockResponse.Builder().code(200).body("{}").build())
        assertEquals("${base(a)}/$sha", client.mirror(signer, base(a), "https://src.example/$sha", sha))
        val m = a.takeRequest()
        assertEquals("/mirror", m.url.encodedPath)
        assertEquals("https://src.example/$sha", (jsonObjectOf(m.body!!.utf8())!!["url"] as JsonPrimitive).content)

        a.enqueue(MockResponse.Builder().code(413).addHeader("X-Reason", "too big").build())
        val p = client.preflight(signer, base(a), sha, 123, "application/octet-stream")
        assertFalse(p.ok)
        assertEquals(413, p.status)
        assertEquals("too big", p.message)
        val h = a.takeRequest()
        assertEquals("HEAD", h.method)
        assertEquals(sha, h.headers["X-SHA-256"])
        assertEquals("123", h.headers["X-Content-Length"])
    }

    @Test fun deleteIsBestEffort() = runBlocking {
        val client = BlossomClient(OkHttpClient())
        a.enqueue(MockResponse.Builder().code(404).build())
        assertTrue(client.delete(signer, base(a), "bb".repeat(32)))
        assertEquals("delete", authOf(a.takeRequest().headers["Authorization"]).tag("t"))
        a.enqueue(MockResponse.Builder().code(500).build())
        assertFalse(client.delete(signer, base(a), "bb".repeat(32)))
    }

    @Test fun onlyHttpsServersAreAccepted() {
        assertTrue(BlossomClient.isAcceptedBlossomUrl("https://blossom.band"))
        assertFalse(BlossomClient.isAcceptedBlossomUrl("http://blossom.band"))
        assertFalse(BlossomClient.isAcceptedBlossomUrl("javascript:alert(1)"))
        assertEquals(listOf("https://a.com", "https://b.com"), BlossomClient.union(listOf("https://a.com/", " https://b.com"), listOf("https://a.com")))
    }
}
