package today.cypherpunk.nostrautica.domain.content

import java.net.URI

/**
 * Talk videos hosted outside Blossom (media/external.ts): an unlisted YouTube
 * link or a direct video file. Only https, never with embedded credentials.
 */
object ExternalVideo {
    private val YOUTUBE_HOSTS = setOf(
        "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
    )

    private fun httpsUrl(raw: String): URI? = runCatching {
        val u = URI(raw.trim())
        if (u.scheme?.lowercase() != "https" || u.host.isNullOrEmpty() || u.rawUserInfo != null) null else u
    }.getOrNull()

    fun isYouTube(raw: String): Boolean = httpsUrl(raw)?.host?.lowercase() in YOUTUBE_HOSTS

    /** The 11-char video id from watch?v=, youtu.be/, /embed/, /shorts/ or /live/. */
    fun youTubeId(raw: String): String? {
        val u = httpsUrl(raw) ?: return null
        val host = u.host.lowercase()
        if (host !in YOUTUBE_HOSTS) return null
        val parts = (u.rawPath ?: "").split('/').filter { it.isNotEmpty() }
        val id = if (host == "youtu.be" || host == "www.youtu.be") parts.firstOrNull()
        else {
            val v = u.rawQuery?.split('&')?.firstOrNull { it.startsWith("v=") }?.substring(2)
            v ?: parts.indexOfFirst { it == "embed" || it == "shorts" || it == "live" }.takeIf { it >= 0 }?.let { parts.getOrNull(it + 1) }
        }
        return id?.takeIf { Regex("^[A-Za-z0-9_-]{11}$").matches(it) }
    }

    /** The host playback will contact, for the consent gate. */
    fun host(raw: String): String? = httpsUrl(raw)?.let { if (it.port > 0) "${it.host}:${it.port}" else it.host }

    /** A canonical watch URL the YouTube app (or a browser) opens. */
    fun youTubeWatchUrl(id: String) = "https://www.youtube.com/watch?v=$id"

    /** A playable direct video URL, or null if it isn't a usable https URL. */
    fun directUrl(raw: String): String? = httpsUrl(raw)?.toString()
}
