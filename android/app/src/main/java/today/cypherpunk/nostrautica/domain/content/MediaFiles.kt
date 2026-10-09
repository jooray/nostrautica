package today.cypherpunk.nostrautica.domain.content

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.isHttpsUrl
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Encrypted Blossom media → a playable local file (media/playback.ts +
 * blossom/client.ts downloadBlob).
 *
 * AES-GCM is whole-file, so nothing streams: the ciphertext is downloaded to a
 * temp file (each mirror in turn, capped at [Limits.MAX_MEDIA_FILE_BYTES],
 * size and sha256 `x` checked), then decrypted with [StreamingGcm] into the
 * plaintext file the player reads, and the ciphertext deleted. Decrypted files
 * live in cacheDir only while a screen holds them ([acquire]/[release]); the
 * last release deletes the file, and [sweep] removes anything a killed process
 * left behind.
 */
class MediaFiles(private val dir: File, http: OkHttpClient) {
    /** Headers within 20 s; then the body only has to keep moving (30 s of silence fails a mirror). */
    private val client = http.newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .pingInterval(0, TimeUnit.SECONDS)
        .build()

    private val refs = HashMap<String, Int>()
    private val locks = HashMap<String, Mutex>()

    data class Progress(val received: Long, val total: Long?, val decrypting: Boolean = false)

    class MediaException(message: String) : IOException(message)

    private fun lockFor(x: String) = synchronized(locks) { locks.getOrPut(x) { Mutex() } }

    private fun plainFile(x: String) = File(dir, "$x.media")

    private var swept = false

    /** Once per process, before the first download: delete what a killed process left behind. */
    private fun sweepOnce() = synchronized(refs) {
        if (swept) return@synchronized
        swept = true
        dir.listFiles()?.forEach { it.delete() }
    }

    /**
     * Download, verify and decrypt [d]; returns the plaintext file and takes a
     * reference to it, which the caller must [release]. A second screen asking
     * for the same `x` while the first download runs waits for it.
     */
    suspend fun acquire(d: MediaDescriptor, onProgress: (Progress) -> Unit): File = withContext(Dispatchers.IO) {
        dir.mkdirs()
        sweepOnce()
        val job = coroutineContext[Job]
        lockFor(d.x).withLock {
            val out = plainFile(d.x)
            synchronized(refs) {
                if (out.exists() && refs[d.x] != null) { refs[d.x] = refs[d.x]!! + 1; return@withLock out }
            }
            if (d.size > Limits.MAX_MEDIA_FILE_BYTES) {
                throw MediaException("This media claims to be ${d.size / 1024 / 1024} MB, over the ${Limits.MAX_MEDIA_FILE_BYTES / 1024 / 1024} MB limit, not downloading it.")
            }
            if (dir.usableSpace < d.size * 2 + 16L * 1024 * 1024) throw MediaException("not enough free storage on this phone")
            val enc = File(dir, "${d.x}.part")
            try {
                download(d, enc, onProgress)
                onProgress(Progress(d.size, d.size, decrypting = true))
                val tmp = File(dir, "${d.x}.dec")
                val r = enc.inputStream().buffered().use { input ->
                    tmp.outputStream().buffered().use { output ->
                        StreamingGcm.decrypt(
                            input, d.size, Bytes.fromBase64(d.decryptionKey), Bytes.fromBase64(d.decryptionNonce), d.ox, output,
                        ) { job?.ensureActive() }
                    }
                }
                if (!r.ok) { tmp.delete(); throw MediaException(r.reason ?: "decryption failed") }
                if (!tmp.renameTo(out)) { tmp.delete(); throw MediaException("could not store the decrypted media") }
                synchronized(refs) { refs[d.x] = (refs[d.x] ?: 0) + 1 }
                out
            } finally {
                enc.delete()
                File(dir, "${d.x}.dec").takeIf { !out.exists() }?.delete()
            }
        }
    }

    /** Drop a reference; the last one deletes the decrypted file. */
    fun release(x: String) = synchronized(refs) {
        val n = (refs[x] ?: return@synchronized) - 1
        if (n <= 0) { refs.remove(x); plainFile(x).delete() } else refs[x] = n
    }

    private suspend fun download(d: MediaDescriptor, target: File, onProgress: (Progress) -> Unit) {
        val cap = Limits.MAX_MEDIA_FILE_BYTES
        var lastErr: String? = null
        for (url in d.url) {
            currentCoroutineContext().ensureActive()
            if (!isHttpsUrl(url)) { lastErr = "not an https URL ($url)"; continue }
            val call = client.newCall(Request.Builder().url(url).build())
            try {
                call.execute().use { res ->
                    if (!res.isSuccessful) throw MediaException("${res.code} from $url")
                    val body = res.body
                    val len = body.contentLength()
                    if (len > cap) throw MediaException("blob is $len bytes, over the $cap-byte cap ($url)")
                    val total = if (len > 0) len else d.size
                    val sha = MessageDigest.getInstance("SHA-256")
                    var received = 0L
                    var lastReport = 0L
                    onProgress(Progress(0, total))
                    body.byteStream().use { input ->
                        target.outputStream().buffered().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val n = input.read(buf)
                                if (n < 0) break
                                received += n
                                if (received > cap || received > d.size) throw MediaException("blob passed the expected size and was aborted ($url)")
                                sha.update(buf, 0, n)
                                out.write(buf, 0, n)
                                if (received - lastReport >= 256 * 1024) { lastReport = received; onProgress(Progress(received, total)) }
                            }
                        }
                    }
                    if (received != d.size) throw MediaException("ciphertext is $received bytes, descriptor declares ${d.size} (size)")
                    if (Bytes.toHex(sha.digest()) != d.x) throw MediaException("hash mismatch from $url")
                }
                return
            } catch (e: kotlinx.coroutines.CancellationException) {
                call.cancel(); target.delete(); throw e
            } catch (e: Exception) {
                call.cancel()
                lastErr = e.message ?: e.javaClass.simpleName
                target.delete()
            }
        }
        throw MediaException("Could not fetch blob: $lastErr")
    }
}
