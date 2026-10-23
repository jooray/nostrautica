package today.cypherpunk.nostrautica.domain.media

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.jsonObjectOf
import today.cypherpunk.nostrautica.protocol.nowSec
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Blossom client (blossom/client.ts; BUD-02 upload/delete, BUD-04 mirror, BUD-06
 * preflight), reusable by any feature: encrypted intro/talk media and public images.
 *
 * The PWA's timeouts carried over, mapped onto OkHttp's per-operation timeouts —
 * which are exactly the "bounded by PROGRESS, not by one wall clock" budgets the
 * PWA had to hand-build:
 * - upload: connect 20 s; write 30 s of silence between body chunks (a slow but
 *   moving upload runs to completion); read 120 s for the response after the last
 *   byte, while the server hashes and stores the blob;
 * - download: 20 s for the headers, 30 s of silence between body chunks;
 * - preflight 10 s and mirror/delete 30 s, whole-call.
 *
 * Auth events are memoized per (verb, sha256) for this process, so a remote signer
 * is asked to sign once per blob, not once per server: a preflight to three servers
 * + an upload + two mirrors used to be six Amber prompts.
 */
class BlossomClient(base: OkHttpClient) {
    private val preflightHttp = base.newBuilder().callTimeout(PREFLIGHT_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    private val mirrorHttp = base.newBuilder().callTimeout(MIRROR_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    private val uploadHttp = base.newBuilder()
        .connectTimeout(UPLOAD_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .writeTimeout(UPLOAD_STALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(UPLOAD_RESPONSE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val downloadHttp = base.newBuilder()
        .connectTimeout(DOWNLOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(DOWNLOAD_STALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    data class UploadProgress(val sent: Long, val total: Long, val server: String)

    private val _progress = MutableStateFlow<UploadProgress?>(null)
    /** The upload in flight (one at a time on the Record screen), for a progress bar. */
    val progress: StateFlow<UploadProgress?> get() = _progress

    data class PreflightResult(val server: String, val ok: Boolean, val status: Int, val message: String? = null)

    data class UploadResult(val urls: List<String>, val sha256: String, val primary: String)

    // ── Auth memo ───────────────────────────────────────────────────────────

    private val authLock = Mutex()
    private val authMemo = HashMap<String, NostrEvent>()

    private suspend fun auth(signer: NostrSigner, verb: BlossomAuth.Verb, sha256: String?): String = authLock.withLock {
        val key = "${signer.pubkey}|${verb.wire}|$sha256"
        val cached = authMemo[key]
        val fresh = cached?.takeIf { (it.tag("expiration")?.toLongOrNull() ?: 0) - nowSec() > AUTH_REUSE_MARGIN_SEC }
        val ev = fresh ?: BlossomAuth.build(signer, verb, sha256).also { authMemo[key] = it }
        BlossomAuth.header(ev)
    }

    // ── BUD-06 preflight ────────────────────────────────────────────────────

    suspend fun preflight(signer: NostrSigner, server: String, sha256: String, size: Long, type: String): PreflightResult {
        val header = runCatching { auth(signer, BlossomAuth.Verb.UPLOAD, sha256) }.getOrElse {
            return PreflightResult(server, false, 0, it.message)
        }
        val req = Request.Builder().url("${trim(server)}/upload").head()
            .header("Authorization", header)
            .header("X-SHA-256", sha256)
            .header("X-Content-Length", size.toString())
            .header("X-Content-Type", type)
            .build()
        return try {
            preflightHttp.newCall(req).await().use { res ->
                PreflightResult(server, res.isSuccessful, res.code, if (res.isSuccessful) null else res.header("X-Reason") ?: res.message)
            }
        } catch (e: IOException) {
            PreflightResult(server, false, 0, e.message)
        }
    }

    // ── BUD-02 upload ───────────────────────────────────────────────────────

    suspend fun upload(signer: NostrSigner, server: String, bytes: ByteArray, contentType: String, onProgress: ((UploadProgress) -> Unit)? = null): String {
        val sha256 = Bytes.sha256Hex(bytes)
        val header = auth(signer, BlossomAuth.Verb.UPLOAD, sha256)
        val total = bytes.size.toLong()
        val emit: (Long) -> Unit = { sent ->
            val p = UploadProgress(minOf(sent, total), total, server)
            _progress.value = p
            runCatching { onProgress?.invoke(p) }
        }
        val body = ProgressBody(bytes, contentType.toMediaType(), emit)
        val req = Request.Builder().url("${trim(server)}/upload").put(body)
            .header("Authorization", header)
            .build()
        emit(0)
        val (code, reason, text) = try {
            uploadHttp.newCall(req).await().use { res -> Triple(res.code, res.header("X-Reason") ?: res.message, res.body.string()) }
        } catch (e: IOException) {
            throw IOException("Upload to $server failed: ${e.message}", e)
        }
        if (code !in 200..299) throw IOException("Upload to $server failed: $code $reason")
        emit(total)
        return boundReplyUrl(server, sha256, (jsonObjectOf(text)?.get("url") as? JsonPrimitive)?.content)
    }

    // ── BUD-04 mirror ───────────────────────────────────────────────────────

    suspend fun mirror(signer: NostrSigner, server: String, sourceUrl: String, sha256: String): String? = try {
        val header = auth(signer, BlossomAuth.Verb.UPLOAD, sha256)
        val body = JsJson.stringify(buildJsonObject { put("url", sourceUrl) }).toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("${trim(server)}/mirror").put(body).header("Authorization", header).build()
        mirrorHttp.newCall(req).await().use { res ->
            if (!res.isSuccessful) null
            else boundReplyUrl(server, sha256, (jsonObjectOf(res.body.string())?.get("url") as? JsonPrimitive)?.content)
        }
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        null
    }

    /**
     * Upload to the first server that takes it, then mirror to the rest in parallel
     * (client.ts uploadAndMirror). A failed PUT falls through to the next candidate.
     */
    suspend fun uploadAndMirror(signer: NostrSigner, servers: List<String>, bytes: ByteArray, contentType: String, onProgress: ((UploadProgress) -> Unit)? = null): UploadResult {
        require(servers.isNotEmpty()) { "no Blossom servers configured" }
        val errors = mutableListOf<String>()
        var primary: String? = null
        var rest = emptyList<String>()
        try {
            for ((i, s) in servers.withIndex()) {
                try {
                    primary = upload(signer, s, bytes, contentType, onProgress)
                    rest = servers.drop(i + 1)
                    break
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    errors += "$s: ${e.message}"
                }
            }
        } finally {
            _progress.value = null
        }
        val p = primary ?: throw IOException("Upload failed on every candidate server: ${errors.joinToString("; ")}")
        val sha = Bytes.sha256Hex(bytes)
        val mirrored = coroutineScope { rest.map { s -> async { mirror(signer, s, p, sha) } }.awaitAll() }
        // A mirror whose address fails the rule is dropped, not allowed to fail the whole descriptor.
        return UploadResult(listOf(p) + mirrored.filterNotNull().filter { it != p && isAcceptedBlossomUrl(it) }, sha, p)
    }

    // ── BUD-02 delete ───────────────────────────────────────────────────────

    /** Best-effort: true on 2xx or 404 (already gone). Never throws. */
    suspend fun delete(signer: NostrSigner, server: String, sha256: String): Boolean = try {
        val header = auth(signer, BlossomAuth.Verb.DELETE, sha256)
        val req = Request.Builder().url("${trim(server)}/$sha256").delete().header("Authorization", header).build()
        mirrorHttp.newCall(req).await().use { it.isSuccessful || it.code == 404 }
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        false
    }

    // ── Download ────────────────────────────────────────────────────────────

    data class DownloadProgress(val received: Long, val total: Long?)

    /**
     * Fetch a blob's ciphertext from the first mirror that serves it, size-capped
     * (audit APPR-4) and verified against [expectedSha256].
     */
    suspend fun download(
        urls: List<String>,
        expectedSha256: String,
        expectedSize: Long? = null,
        maxBytes: Long = Limits.MAX_MEDIA_FILE_BYTES,
        onProgress: ((DownloadProgress) -> Unit)? = null,
    ): ByteArray {
        if (expectedSize != null && expectedSize > maxBytes) throw IOException("refusing to download: the descriptor claims $expectedSize bytes, over the $maxBytes-byte cap")
        var last: Exception? = null
        for (url in urls.filter(::isAcceptedBlossomUrl)) {
            try {
                return withContext(Dispatchers.IO) {
                    downloadHttp.newCall(Request.Builder().url(url).get().build()).await().use { res ->
                        if (!res.isSuccessful) throw IOException("${res.code} from $url")
                        val len = res.body.contentLength()
                        if (len > maxBytes) throw IOException("blob is $len bytes, over the $maxBytes-byte cap ($url)")
                        val total = if (len > 0) len else expectedSize
                        val out = ByteArrayOutputStream(if (total != null && total in 1..Int.MAX_VALUE.toLong()) total.toInt() else 64 * 1024)
                        val buf = ByteArray(64 * 1024)
                        var received = 0L
                        onProgress?.invoke(DownloadProgress(0, total))
                        res.body.byteStream().use { input ->
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                received += n
                                if (received > maxBytes) throw IOException("blob passed the $maxBytes-byte download cap and was aborted ($url)")
                                out.write(buf, 0, n)
                                onProgress?.invoke(DownloadProgress(received, total))
                            }
                        }
                        val bytes = out.toByteArray()
                        if (Bytes.sha256Hex(bytes) != expectedSha256) throw IOException("hash mismatch from $url")
                        bytes
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                last = e
            }
        }
        throw IOException("Could not fetch blob: ${last?.message}")
    }

    companion object {
        const val PREFLIGHT_TIMEOUT_MS = 10_000L
        const val MIRROR_TIMEOUT_MS = 30_000L
        const val UPLOAD_CONNECT_TIMEOUT_MS = 20_000L
        const val UPLOAD_STALL_TIMEOUT_MS = 30_000L
        const val UPLOAD_RESPONSE_TIMEOUT_MS = 120_000L
        const val DOWNLOAD_TIMEOUT_MS = 20_000L
        const val DOWNLOAD_STALL_TIMEOUT_MS = 30_000L
        private const val AUTH_REUSE_MARGIN_SEC = 600L

        /**
         * The one Blossom URL rule (audit APPR-8, R-71): https with a host, no userinfo,
         * and no host on this phone or its network (loopback, RFC 1918, link-local,
         * CGNAT, ULA, `localhost`/`.local`). Server lists and descriptor URLs come from
         * peers (10063 tags, configs, replies), and a phone fetching what they name must
         * not become a probe of the LAN it sits on. The build's own servers are exempt by
         * origin, so a dev build pointed at https://localhost keeps working. Ports are
         * not restricted: the host is what matters, and real servers do use other ports.
         */
        fun isAcceptedBlossomUrl(url: String): Boolean {
            val u = runCatching { URI(url.trim()) }.getOrNull() ?: return false
            if (!u.scheme.equals("https", ignoreCase = true) || u.host.isNullOrEmpty() || u.rawUserInfo != null) return false
            return !isLocalHost(u.host) || origin(u) in buildOrigins
        }

        private val buildOrigins by lazy {
            today.cypherpunk.nostrautica.nostr.Relays.BLOSSOM.mapNotNull { runCatching { origin(URI(it.trim())) }.getOrNull() }.toSet()
        }

        /**
         * The URL to publish for a blob a [server] just took (audit MED-9, R-20/R-21): its reply
         * `url` only when it is accepted, on the SAME origin we asked, and its last path segment
         * starts with our hash; otherwise the BUD-01 address every server must serve. A substring
         * check let `https://evil.example/?x=<sha>` through as the blob's location.
         */
        fun boundReplyUrl(server: String, sha256: String, reply: String?): String {
            val fallback = "${trim(server)}/$sha256"
            val r = reply?.trim()?.takeIf { it.isNotEmpty() && isAcceptedBlossomUrl(it) } ?: return fallback
            val u = runCatching { URI(r) }.getOrNull() ?: return fallback
            val s = runCatching { URI(trim(server.trim())) }.getOrNull() ?: return fallback
            if (origin(u) != origin(s)) return fallback
            val last = u.rawPath?.substringAfterLast('/') ?: return fallback
            return if (last.lowercase().startsWith(sha256.lowercase())) r else fallback
        }

        internal fun origin(u: URI): String {
            val port = if (u.port == -1 && u.scheme.equals("https", ignoreCase = true)) 443 else u.port
            return "${u.scheme?.lowercase()}://${u.host?.lowercase()}:$port"
        }

        /** A host literal that names this device or a private network. Names are not resolved. */
        internal fun isLocalHost(rawHost: String): Boolean {
            val h = rawHost.lowercase().removePrefix("[").removeSuffix("]").trimEnd('.')
            if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
            val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(h.removePrefix("::ffff:"))
            if (v4 != null) {
                val (a, b) = v4.destructured.let { it.component1().toInt() to it.component2().toInt() }
                return a == 0 || a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && b in 16..31) ||
                    (a == 192 && b == 168) || (a == 100 && b in 64..127) || a >= 224
            }
            if (':' in h) {
                return h == "::" || h == "::1" || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") ||
                    h.startsWith("feb") || h.startsWith("fc") || h.startsWith("fd")
            }
            return false
        }

        fun trim(server: String) = server.trimEnd('/')

        /** relays.ts unionRelays for server lists: trimmed, deduped, order kept. */
        fun union(vararg lists: List<String>): List<String> {
            val seen = LinkedHashSet<String>()
            for (l in lists) for (s in l) seen += trim(s.trim())
            return seen.filter { it.isNotEmpty() }
        }
    }
}

/** A request body that reports bytes as they go out, in 64 KiB writes. */
private class ProgressBody(private val bytes: ByteArray, private val type: MediaType, private val onSent: (Long) -> Unit) : RequestBody() {
    override fun contentType() = type
    override fun contentLength() = bytes.size.toLong()
    override fun writeTo(sink: BufferedSink) {
        var off = 0
        while (off < bytes.size) {
            val n = minOf(CHUNK, bytes.size - off)
            sink.write(bytes, off, n)
            sink.flush()
            off += n
            onSent(off.toLong())
        }
    }

    companion object { const val CHUNK = 64 * 1024 }
}

/** OkHttp call as a cancellable suspend. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
    })
}
