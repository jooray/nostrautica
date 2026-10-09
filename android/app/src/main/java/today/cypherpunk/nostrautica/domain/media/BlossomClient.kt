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
        // Take the server's URL only when it points at OUR blob (audit MED-9).
        val serverUrl = (jsonObjectOf(text)?.get("url") as? JsonPrimitive)?.content?.takeIf { it.contains(sha256) && isAcceptedBlossomUrl(it) }
        return serverUrl ?: "${trim(server)}/$sha256"
    }

    // ── BUD-04 mirror ───────────────────────────────────────────────────────

    suspend fun mirror(signer: NostrSigner, server: String, sourceUrl: String, sha256: String): String? = try {
        val header = auth(signer, BlossomAuth.Verb.UPLOAD, sha256)
        val body = JsJson.stringify(buildJsonObject { put("url", sourceUrl) }).toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("${trim(server)}/mirror").put(body).header("Authorization", header).build()
        mirrorHttp.newCall(req).await().use { res ->
            if (!res.isSuccessful) null
            else ((jsonObjectOf(res.body.string())?.get("url") as? JsonPrimitive)?.content?.takeIf { it.contains(sha256) && isAcceptedBlossomUrl(it) })
                ?: "${trim(server)}/$sha256"
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
        return UploadResult(listOf(p) + mirrored.filterNotNull().filter { it != p }, sha, p)
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

        /** https only (audit APPR-8): server lists come from unvalidated 10063 tags too. */
        fun isAcceptedBlossomUrl(url: String): Boolean =
            runCatching { URI(url).let { it.scheme == "https" && !it.host.isNullOrEmpty() } }.getOrDefault(false)

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
