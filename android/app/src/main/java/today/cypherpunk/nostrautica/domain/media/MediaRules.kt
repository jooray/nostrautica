package today.cypherpunk.nostrautica.domain.media

import today.cypherpunk.nostrautica.protocol.Limits
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
