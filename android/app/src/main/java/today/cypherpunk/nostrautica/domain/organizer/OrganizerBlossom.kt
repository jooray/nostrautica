package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.isHttpsUrl
import today.cypherpunk.nostrautica.protocol.jsonObjectOf
import today.cypherpunk.nostrautica.protocol.nowSec
import java.util.concurrent.TimeUnit

/**
 * A minimal Blossom client for the organizer's PUBLIC images (event icon, banner,
 * post header): BUD-02 PUT /upload with a kind-24242 auth, then BUD-04 mirrors in
 * parallel (blossom/client.ts uploadAndMirror + media/image.ts uploadPublicImage).
 * Private to this package so it can't collide with the shared media client.
 */
class OrganizerBlossom(http: OkHttpClient, private val nostr: Nostr, private val cache: Cache) {
    private val client = http.newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    class UploadFailed(message: String) : Exception(message)

    private suspend fun authHeader(signer: NostrSigner, verb: String, sha256: String): String {
        val now = nowSec()
        val ev = signer.sign(signer.template(Kinds.BLOSSOM_AUTH, "", listOf(listOf("t", verb), listOf("x", sha256), listOf("expiration", (now + 3600).toString())), now))
        return "Nostr " + Bytes.toBase64(Bytes.utf8(ev.toJsonString()))
    }

    /** The user's own kind-10063 servers (cache-first, refreshed at most hourly). */
    private suspend fun userServers(pubkey: String): List<String> {
        val f = Filter(kinds = listOf(Kinds.BLOSSOM_SERVERS), authors = listOf(pubkey))
        if (!cache.isFresh("10063:$pubkey", 3600_000L)) {
            runCatching { nostr.fetch(Relays.READ, f, timeoutMs = 5_000) }
            cache.markFetched("10063:$pubkey")
        }
        return nostr.store.latest(Kinds.BLOSSOM_SERVERS, pubkey)?.tagValues("server") ?: emptyList()
    }

    private fun trim(s: String) = s.trimEnd('/')

    private suspend fun upload(signer: NostrSigner, server: String, bytes: ByteArray, mime: String, sha: String): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("${trim(server)}/upload")
            .put(bytes.toRequestBody(mime.toMediaType()))
            .header("Authorization", authHeader(signer, "upload", sha))
            .build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw UploadFailed("Upload to $server failed: ${res.code} ${res.header("X-Reason") ?: res.message}")
            val body = res.body?.string().orEmpty()
            // Take the server's URL only if it points at OUR blob (audit MED-9).
            val url = (jsonObjectOf(body)?.get("url") as? JsonPrimitive)?.content?.takeIf { sha in it }
            url ?: "${trim(server)}/$sha"
        }
    }

    private suspend fun mirror(signer: NostrSigner, server: String, url: String, sha: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            withTimeoutOrNull(30_000) {
                val body: JsonObject = buildJsonObject { put("url", JsonPrimitive(url)) }
                val req = Request.Builder().url("${trim(server)}/mirror")
                    .put(JsJson.stringify(body).toRequestBody("application/json".toMediaType()))
                    .header("Authorization", authHeader(signer, "upload", sha))
                    .build()
                client.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) null
                    else (jsonObjectOf(res.body?.string().orEmpty())?.get("url") as? JsonPrimitive)?.content?.takeIf { sha in it } ?: "${trim(server)}/$sha"
                }
            }
        }.getOrNull()
    }

    /** Upload a public image; returns its first URL. Event servers first, then the user's, then defaults. */
    suspend fun uploadPublicImage(signer: NostrSigner, bytes: ByteArray, mime: String = "image/jpeg", eventBlossom: List<String> = emptyList()): String {
        val servers = (eventBlossom + userServers(signer.pubkey) + Relays.BLOSSOM).map(::trim).distinct().filter(::isHttpsUrl)
        if (servers.isEmpty()) throw UploadFailed("no Blossom servers configured")
        val sha = Bytes.sha256Hex(bytes)
        val errors = mutableListOf<String>()
        for ((i, s) in servers.withIndex()) {
            val url = runCatching { upload(signer, s, bytes, mime, sha) }.getOrElse { errors += "$s: ${it.message}"; null } ?: continue
            coroutineScope { servers.drop(i + 1).map { async { mirror(signer, it, url, sha) } }.awaitAll() }
            return url
        }
        throw UploadFailed("Upload failed on every candidate server: ${errors.joinToString("; ")}")
    }
}
