package today.cypherpunk.nostrautica.domain.join

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import java.net.URI

/**
 * Authored event-profile fields (events/authored-profile.ts): the editable form,
 * the submission built from it, and the repair that keeps a submission inside the
 * coordinator's schema. A 21601 the coordinator rejects is dropped forever while
 * the app says "Saved", so everything is bounded and repaired before signing.
 */
@Serializable
data class AuthoredFields(
    val about: String = "",
    /** Comma-separated in the form. */
    val skills: String = "",
    val lookingFor: String = "",
    /** One per line in the form. */
    val links: String = "",
    val introText: String = "",
)

data class NormalizedProfile(val profile: AttendeeProfile, val dropped: List<String>)

object AuthoredProfile {
    fun fieldsFrom(profile: AttendeeProfile?, introText: String?) = AuthoredFields(
        about = profile?.about ?: "",
        skills = (profile?.skills ?: emptyList()).joinToString(", "),
        lookingFor = profile?.lookingFor ?: "",
        links = (profile?.links ?: emptyList()).joinToString("\n"),
        introText = introText ?: "",
    )

    /** Deduped, trimmed, non-empty (a duplicate key used to crash the organizer's queue). */
    fun parseList(s: String, sep: Regex): List<String> =
        s.split(sep).map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    data class Built(val profile: AttendeeProfile, val introText: String?, val media: List<MediaDescriptor>)

    /** Media passes through untouched: editing text must never drop a recording. */
    fun build(fields: AuthoredFields, existingMedia: List<MediaDescriptor>) = Built(
        profile = AttendeeProfile(
            about = fields.about.trim(),
            skills = parseList(fields.skills, Regex(",")),
            lookingFor = fields.lookingFor.trim(),
            links = parseList(fields.links, Regex("[\\n,]")),
        ),
        introText = fields.introText.trim().ifEmpty { null },
        media = existingMedia,
    )

    fun changed(current: AuthoredFields, baseline: AuthoredFields): Boolean =
        current.about.trim() != baseline.about.trim() ||
            current.skills.trim() != baseline.skills.trim() ||
            current.lookingFor.trim() != baseline.lookingFor.trim() ||
            current.links.trim() != baseline.links.trim() ||
            current.introText.trim() != baseline.introText.trim()

    private val HOSTNAME_LIKE = Regex("^[a-z0-9][a-z0-9-]*(\\.[a-z0-9-]+)*\\.[a-z]{2,}([:/?#]|$)", RegexOption.IGNORE_CASE)
    private val HAS_SCHEME = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)

    /**
     * A bare `example.com` gets `https://`; a handle like `@me` is NOT turned into a
     * link to a host that doesn't exist; mailto:/javascript: are rejected.
     */
    fun normalizeLink(raw: String): String? {
        val value = raw.trim()
        if (value.isEmpty()) return null
        val candidate = when {
            HAS_SCHEME.containsMatchIn(value) -> value
            HOSTNAME_LIKE.containsMatchIn(value) -> "https://$value"
            else -> return null
        }
        return runCatching {
            val u = URI(candidate)
            val scheme = u.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            val host = u.host ?: return null
            if (!host.contains('.')) return null
            // As WHATWG `new URL().href`: lowercase scheme and host, "/" for a bare origin.
            val authority = u.rawAuthority ?: return null
            val rest = candidate.substring(candidate.indexOf(authority) + authority.length)
            val path = if (rest.isEmpty() || rest[0] == '?' || rest[0] == '#') "/$rest" else rest
            "$scheme://${authority.lowercase()}$path".takeIf { it.length <= Limits.MAX_URL }
        }.getOrNull()
    }

    fun normalize(profile: AttendeeProfile): NormalizedProfile {
        val dropped = mutableListOf<String>()
        val links = mutableListOf<String>()
        for (raw in profile.links) {
            val url = normalizeLink(raw)
            if (url == null) { if (raw.trim().isNotEmpty()) dropped += raw.trim(); continue }
            if (url !in links) links += url
        }
        val skills = mutableListOf<String>()
        for (raw in profile.skills) {
            val s = raw.trim().take(Limits.MAX_SKILL)
            if (s.isNotEmpty() && s !in skills) skills += s
        }
        return NormalizedProfile(
            AttendeeProfile(
                about = profile.about.trim().take(Limits.MAX_ABOUT),
                skills = skills.take(Limits.MAX_SKILLS),
                lookingFor = profile.lookingFor.trim().take(Limits.MAX_LOOKING_FOR),
                links = links.take(Limits.MAX_LINKS),
            ),
            dropped,
        )
    }

    fun empty() = AttendeeProfile("", emptyList(), "", emptyList())
}
