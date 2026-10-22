package today.cypherpunk.nostrautica.domain.media

import today.cypherpunk.nostrautica.protocol.Limits
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URI

/** Client-side media precheck (media/precheck.ts): fail before a doomed upload. */
object Precheck {
    /** Must equal the playback ceiling, so anything accepted for upload is playable (R17). */
    const val MAX_UPLOAD_BYTES = Limits.MAX_MEDIA_FILE_BYTES

    data class Violation(val kind: String, val limit: Long, val actual: Long)

    /** Seconds, or 0 = unknown (never Infinity/NaN). */
    fun normalizeDurationSec(raw: Double?): Int =
        if (raw == null || !raw.isFinite() || raw <= 0) 0 else Math.round(raw).toInt()

    /** `maxSec == 0` = unlimited; `durationSec == 0` = unknown (never rejected on). */
    fun check(sizeBytes: Long, durationSec: Double?, maxSec: Int): Violation? {
        val d = normalizeDurationSec(durationSec)
        if (maxSec > 0 && d > 0 && d > maxSec) return Violation("duration", maxSec.toLong(), d.toLong())
        if (sizeBytes > MAX_UPLOAD_BYTES) return Violation("size", MAX_UPLOAD_BYTES, sizeBytes)
        return null
    }

    /**
     * What a picked file is uploaded as, from its probed tracks and never from the
     * provider-declared MIME (audit R-22): the type decides how it is stripped, so a
     * video the provider calls audio must not skip the video re-mux. Audio mode
     * always drops any video track.
     */
    fun pickedMime(mode: String, hasVideo: Boolean): String =
        if (mode == "audio" || !hasVideo) "audio/mp4" else "video/mp4"
}

/**
 * Reads that stop at a byte cap (audit R-74). A content provider's declared SIZE
 * is advisory (absent as -1, or simply wrong), so a picked stream is only trusted
 * as far as the cap: past it the read gives up rather than filling the cache or
 * the heap with whatever the provider yields.
 */
object Bounded {
    /** A picked photo to crop: far above any phone camera's JPEG, far below the heap. */
    const val MAX_PICKED_IMAGE_BYTES = 40L * 1024 * 1024

    /** Copy at most [max] bytes; false (with [out] incomplete) when [input] holds more. */
    fun copy(input: InputStream, out: OutputStream, max: Long): Boolean {
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) return true
            total += n
            if (total > max) return false
            out.write(buf, 0, n)
        }
    }

    /** All of [input] when it is at most [max] bytes, else null. */
    fun readBytes(input: InputStream, max: Long): ByteArray? {
        val out = ByteArrayOutputStream()
        return if (copy(input, out, max)) out.toByteArray() else null
    }
}

/** External talk URLs (media/external.ts): YouTube or a direct video, https only. */
object ExternalUrl {
    private val YOUTUBE_HOSTS = setOf(
        "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
    )
    private val ID = Regex("^[A-Za-z0-9_-]{11}$")

    data class Classified(val kind: String, val url: String)

    /** https, no embedded credentials (audit U10). */
    private fun https(raw: String): URI? = runCatching {
        val u = URI(raw.trim())
        if (u.scheme?.lowercase() != "https" || u.host.isNullOrEmpty() || u.rawUserInfo != null) null else u
    }.getOrNull()

    fun youTubeId(raw: String): String? {
        val u = https(raw) ?: return null
        val host = u.host.lowercase()
        if (host !in YOUTUBE_HOSTS) return null
        val parts = (u.path ?: "").split('/').filter { it.isNotEmpty() }
        val id = if (host == "youtu.be" || host == "www.youtu.be") parts.firstOrNull()
        else (u.rawQuery ?: "").split('&').firstOrNull { it.startsWith("v=") }?.removePrefix("v=")
            ?: parts.indexOfFirst { it == "embed" || it == "shorts" || it == "live" }.takeIf { it >= 0 }?.let { parts.getOrNull(it + 1) }
        return id?.takeIf { ID.matches(it) }
    }

    /** null when unusable; a YouTube host without a video id is rejected, not treated as a file. */
    fun classify(raw: String): Classified? {
        val u = https(raw) ?: return null
        val normalized = u.toString()
        return if (u.host.lowercase() in YOUTUBE_HOSTS) youTubeId(raw)?.let { Classified("youtube", normalized) }
        else Classified("video", normalized)
    }
}

/** Gallery order for the intro reuse library (media/library-order.ts): newest first. */
object LibraryOrder {
    fun <T> order(items: List<T>, x: (T) -> String, at: Map<String, Long>): List<T> =
        items.withIndex().sortedWith { a, b ->
            val av = at[x(a.value)]
            val bv = at[x(b.value)]
            if (av != null && bv != null) bv.compareTo(av) else b.index.compareTo(a.index)
        }.map { it.value }
}
