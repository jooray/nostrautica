@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package today.cypherpunk.nostrautica.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.net.URI

/**
 * Payload schemas (schemas.ts). Field names are the wire names. Every type has a
 * `validate()` that enforces the same bounds the zod schemas do; [Wire.parse] runs
 * it and classifies a payload from a newer protocol so the UI can say "update
 * required" instead of silently dropping it.
 */
object Wire {
    const val PROTOCOL_VERSION = 2
    const val PROTOCOL_VERSION_TAG = "2"
    const val ROSTER_PAGED_VERSION = 3

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        coerceInputValues = false
        isLenient = false
        classDiscriminator = "type"
    }

    class InvalidPayload(message: String) : Exception(message)

    class NewerProtocolVersion(val version: Int) :
        Exception("payload requires protocol v$version; this client speaks v$PROTOCOL_VERSION. Update required")

    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        data class Newer(val version: Int) : Result<Nothing>
        data class Invalid(val error: String) : Result<Nothing>
    }

    fun payloadVersion(raw: JsonElement): Int? = ((raw as? JsonObject)?.get("v") as? JsonPrimitive)?.intOrNull

    fun eventVersionTag(tags: List<List<String>>): Int? =
        tags.firstOrNull { it.isNotEmpty() && it[0] == "v" }?.getOrNull(1)?.toIntOrNull()

    fun hasCurrentVersionTag(tags: List<List<String>>) = eventVersionTag(tags) == PROTOCOL_VERSION
    fun isNewerVersionTag(tags: List<List<String>>) = (eventVersionTag(tags) ?: 0) > PROTOCOL_VERSION

    fun <T : Validated> parseSafe(serializer: KSerializer<T>, text: String): Result<T> {
        val raw = runCatching { json.parseToJsonElement(text) }.getOrElse { return Result.Invalid("not JSON") }
        return parseSafe(serializer, raw)
    }

    fun <T : Validated> parseSafe(serializer: KSerializer<T>, raw: JsonElement): Result<T> {
        val v = payloadVersion(raw)
        val decoded = runCatching { json.decodeFromJsonElement(serializer, raw).also { it.validate() } }
        decoded.getOrNull()?.let { return Result.Ok(it) }
        if (v != null && v > PROTOCOL_VERSION) return Result.Newer(v)
        return Result.Invalid(decoded.exceptionOrNull()?.message ?: "invalid payload")
    }

    /** Throwing form: [NewerProtocolVersion] or [InvalidPayload]. */
    fun <T : Validated> parse(serializer: KSerializer<T>, text: String): T = when (val r = parseSafe(serializer, text)) {
        is Result.Ok -> r.value
        is Result.Newer -> throw NewerProtocolVersion(r.version)
        is Result.Invalid -> throw InvalidPayload(r.error)
    }

    fun <T : Validated> encode(serializer: KSerializer<T>, value: T): String {
        value.validate()
        return json.encodeToString(serializer, value)
    }
}

/** A payload that checks its own bounds (the zod refinements). */
interface Validated {
    fun validate()
}

object Limits {
    const val MAX_URL = 2048
    const val MAX_MEDIA_URLS = 8
    const val MAX_MEDIA_FILE_BYTES = 250L * 1024 * 1024
    const val MAX_LANG = 35
    const val MAX_TRANSCRIPT_TEXT = 100_000
    const val MAX_INTRO_TEXT = 2000
    const val MAX_LIBRARY_TEXTS = 20
    const val MAX_NAME = 200
    const val MAX_MESSAGE = 2000
    const val MAX_ABOUT = 5000
    const val MAX_LOOKING_FOR = 2000
    const val MAX_SKILLS = 50
    const val MAX_SKILL = 200
    const val MAX_LINKS = 20
    const val MAX_INVITE_LABEL = 100
    const val MAX_INVITES = 10000
    const val MAX_INVITE_USES = 5000
    const val MAX_REASONING = 2000
    const val MAX_MATCHES = 100
    const val MAX_ICEBREAKERS = 3
    const val MAX_ICEBREAKER = 280
    const val MAX_ROSTER = 2000
    const val MAX_ROSTER_PAGE = 700
    const val MAX_ROSTER_PAGES = 40
    const val MAX_RELAYS = 30
    const val MAX_MEDIA = 20
    const val MAX_SUBMISSION_MEDIA = 4
    const val MAX_D = 200
    const val MAX_TITLE = 300
    const val MAX_POST_BODY = 100_000
    const val MAX_NOTES = 2000
    const val MAX_NOTE = 5000
    const val MAX_TRANSCRIPTS = 20
    const val MAX_PAGE_SECTIONS = 50
    const val MAX_PINNED_REFS = 50
    const val MAX_TALK_TITLE = 200
    const val MAX_TALK_DESC = 2000
    const val MAX_CHAT_KEY_LABEL = 60
    const val MAX_CHAT_KEY_CLIENT_ID = 120
    const val MAX_CHAT_KEYS_PER_ACCOUNT = 10
    const val MAX_CHAT_LINK_CODE_INPUT = 32
    const val MAX_DM_READ_THREADS = 200
    const val MAX_FEED_SOURCES = 10
    const val MAX_FEED_TAGS = 10
    const val MAX_FEED_TAG = 100
    const val ADMIN_COMMAND_TTL_SEC = 172_800L
    const val MAX_ADMIN_ARGS = 12
    const val INVITE_USES_UNLIMITED = 0
    const val CHAT_LINK_CODE_LENGTH = 8
    const val CHAT_LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
}

internal fun check(cond: Boolean, msg: () -> String) {
    if (!cond) throw Wire.InvalidPayload(msg())
}

internal fun checkVersion(v: Int) = check(v == Wire.PROTOCOL_VERSION) { "unsupported v $v" }
internal fun checkLen(s: String?, max: Int, field: String) = check(s == null || s.length <= max) { "$field longer than $max" }
internal fun checkList(l: List<*>?, max: Int, field: String) = check(l == null || l.size <= max) { "$field has more than $max items" }
internal fun checkHex32(s: String?, field: String) = check(s == null || s.isHex32()) { "$field is not 32-byte hex" }
internal fun checkStrings(l: List<String>?, maxItems: Int, maxLen: Int, field: String) {
    checkList(l, maxItems, field)
    l?.forEach { checkLen(it, maxLen, field) }
}

fun isHttpsUrl(s: String): Boolean = runCatching { URI(s).let { it.scheme == "https" && !it.host.isNullOrEmpty() } }.getOrDefault(false)
fun isWssUrl(s: String): Boolean = runCatching { URI(s).let { it.scheme == "wss" && !it.host.isNullOrEmpty() } }.getOrDefault(false)

private fun base64Len(s: String): Int {
    if (s.isEmpty() || s.length % 4 != 0 || !Regex("^[A-Za-z0-9+/]+={0,2}$").matches(s)) return -1
    val pad = if (s.endsWith("==")) 2 else if (s.endsWith("=")) 1 else 0
    return s.length / 4 * 3 - pad
}

// ── Media ────────────────────────────────────────────────────────────────

@Serializable
data class MediaDescriptor(
    val kind: String,
    val url: List<String>,
    val x: String,
    val ox: String,
    val size: Long,
    val m: String,
    val duration: Double? = null,
    @SerialName("encryption-algorithm") val encryptionAlgorithm: String = "aes-gcm",
    @SerialName("decryption-key") val decryptionKey: String,
    @SerialName("decryption-nonce") val decryptionNonce: String,
) : Validated {
    val isAudio get() = m.startsWith("audio/")
    val isVideo get() = m.startsWith("video/")

    /** The draft form (before upload) may have no URLs yet. */
    fun validateDraft() {
        check(kind == "intro" || kind == "talk") { "media kind must be intro|talk" }
        checkHex32(x, "x"); checkHex32(ox, "ox")
        check(size >= 1) { "size must be ≥ 1" }
        check(encryptionAlgorithm == "aes-gcm") { "unsupported encryption-algorithm" }
        check(base64Len(decryptionKey) == 32) { "decryption-key must be 32 bytes" }
        check(base64Len(decryptionNonce) == 12) { "decryption-nonce must be 12 bytes" }
        check(duration == null || (duration.isFinite() && duration >= 0)) { "duration must be non-negative" }
        check(!(isAudio || isVideo) || duration != null) { "duration is required for audio/video media" }
    }

    override fun validate() {
        validateDraft()
        check(url.isNotEmpty() && url.size <= Limits.MAX_MEDIA_URLS) { "media needs 1..${Limits.MAX_MEDIA_URLS} urls" }
        url.forEach { check(it.length <= Limits.MAX_URL && isHttpsUrl(it)) { "media url must be https" } }
    }
}

@Serializable
data class MediaTranscript(
    val x: String,
    val text: String,
    val lang: String,
    val source: String,
    @SerialName("updated_at") val updatedAt: Long,
) : Validated {
    override fun validate() {
        checkHex32(x, "x"); checkLen(text, Limits.MAX_TRANSCRIPT_TEXT, "text"); checkLen(lang, Limits.MAX_LANG, "lang")
        check(source == "stt" || source == "authored") { "transcript source" }
    }
}

// ── Profiles ─────────────────────────────────────────────────────────────

@Serializable
data class AttendeeProfile(
    val about: String = "",
    val skills: List<String> = emptyList(),
    @SerialName("looking_for") val lookingFor: String = "",
    val links: List<String> = emptyList(),
) : Validated {
    override fun validate() {
        checkLen(about, Limits.MAX_ABOUT, "about")
        checkStrings(skills, Limits.MAX_SKILLS, Limits.MAX_SKILL, "skills")
        checkLen(lookingFor, Limits.MAX_LOOKING_FOR, "looking_for")
        checkList(links, Limits.MAX_LINKS, "links")
        links.forEach { check(it.length <= Limits.MAX_URL && isHttpsUrl(it)) { "links must be https URLs" } }
    }
}

@Serializable
data class ProfileTranslation(
    val lang: String,
    val about: String? = null,
    @SerialName("looking_for") val lookingFor: String? = null,
    val skills: List<String>? = null,
)

@Serializable
data class AiProfile(
    val summary: String,
    val skills: List<String> = emptyList(),
    val interests: List<String> = emptyList(),
    val offers: List<String> = emptyList(),
    val seeks: List<String> = emptyList(),
    val translations: ProfileTranslation? = null,
) : Validated {
    val hasContent: Boolean
        get() = summary.isNotBlank() || skills.isNotEmpty() || interests.isNotEmpty() || offers.isNotEmpty() || seeks.isNotEmpty()

    override fun validate() {
        checkLen(summary, Limits.MAX_ABOUT, "summary")
        for ((name, l) in listOf("skills" to skills, "interests" to interests, "offers" to offers, "seeks" to seeks)) {
            checkStrings(l, Limits.MAX_SKILLS, Limits.MAX_SKILL, name)
        }
    }

    companion object {
        val FIELDS = listOf("summary", "skills", "interests", "offers", "seeks")
    }
}

@Serializable
data class AiProfileOverride(
    val summary: String? = null,
    val skills: List<String>? = null,
    val interests: List<String>? = null,
    val offers: List<String>? = null,
    val seeks: List<String>? = null,
)

// ── Invites, joins, submissions ──────────────────────────────────────────

@Serializable
data class InviteEntry(val h: String, val label: String? = null, val uses: Int? = null, val exp: Long? = null) {
    val effectiveUses: Int get() = uses ?: 1
}

@Serializable
data class InviteListContent(val v: Int = Wire.PROTOCOL_VERSION, val invites: List<InviteEntry>) : Validated {
    override fun validate() {
        checkVersion(v); checkList(invites, Limits.MAX_INVITES, "invites")
        invites.forEach {
            checkHex32(it.h, "h"); checkLen(it.label, Limits.MAX_INVITE_LABEL, "label")
            check(it.uses == null || it.uses in 0..Limits.MAX_INVITE_USES) { "uses" }
            check(it.exp == null || it.exp > 0) { "exp" }
        }
    }
}

@Serializable
data class JoinRequestContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val name: String,
    val message: String = "",
    @SerialName("rsvp_public") val rsvpPublic: Boolean = false,
) : Validated {
    override fun validate() {
        checkVersion(v); checkLen(name, Limits.MAX_NAME, "name"); checkLen(message, Limits.MAX_MESSAGE, "message")
    }
}

@Serializable
data class ProfileSubmissionContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val rev: Long,
    val profile: AttendeeProfile,
    val media: List<MediaDescriptor> = emptyList(),
    @SerialName("intro_text") val introText: String? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); check(rev >= 0) { "rev" }
        profile.validate()
        checkList(media, Limits.MAX_SUBMISSION_MEDIA, "media"); media.forEach { it.validate() }
        checkLen(introText, Limits.MAX_INTRO_TEXT, "intro_text")
    }
}

@Serializable
data class ProfileCorrectionContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    val rev: Long,
    val overrides: AiProfileOverride? = null,
    val hidden: Boolean? = null,
    @SerialName("hidden_fields") val hiddenFields: List<String>? = null,
    val report: String? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); check(rev >= 0) { "rev" }
        hiddenFields?.forEach { check(it in AiProfile.FIELDS) { "hidden_fields" } }
        checkLen(report, Limits.MAX_INTRO_TEXT, "report")
    }
}

@Serializable
data class EckVersion(val id: Int, val key: String) : Validated {
    fun bytes(): ByteArray = Bytes.fromBase64(key)
    override fun validate() {
        check(id > 0) { "eck id must be positive" }
        check(base64Len(key) == 32) { "eck key must be 32 bytes" }
    }
}

@Serializable
data class KeyGrantContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    val role: String,
    val eck: List<EckVersion>,
    @SerialName("granted_by") val grantedBy: String,
) : Validated {
    override fun validate() {
        checkVersion(v); check(Coordinate.isSpace(a)) { "a must be an event coordinate" }
        check(role == "attendee" || role == "organizer") { "role" }
        eck.forEach { it.validate() }; checkHex32(grantedBy, "granted_by")
    }
}

@Serializable
data class CoordinatorGrantContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    val gen: Int,
    @SerialName("inbox_nsec") val inboxNsec: String,
    val eck: List<EckVersion>,
    @SerialName("config_relays") val configRelays: List<String>,
) : Validated {
    override fun validate() {
        checkVersion(v); check(Coordinate.isSpace(a)) { "a" }; check(gen > 0) { "gen" }
        checkHex32(inboxNsec, "inbox_nsec"); eck.forEach { it.validate() }; checkList(configRelays, Limits.MAX_RELAYS, "config_relays")
    }
}

@Serializable
data class AdminCommandContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    val cmd: String,
    val args: JsonObject = JsonObject(emptyMap()),
    val expires: Long,
) : Validated {
    override fun validate() {
        checkVersion(v)
        check(cmd in setOf("approve", "recompute", "reprocess", "revoke", "talk_publish", "talk_reject", "detach")) { "cmd" }
        check(args.size <= Limits.MAX_ADMIN_ARGS) { "args" }
    }
}

@Serializable
data class OrganizerGrantContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    @SerialName("eid_nsec") val eidNsec: String,
    @SerialName("einbox_nsec") val einboxNsec: String,
    val eck: List<EckVersion>,
    @SerialName("config_relays") val configRelays: List<String>,
    @SerialName("granted_by") val grantedBy: String,
) : Validated {
    override fun validate() {
        checkVersion(v); check(Coordinate.isSpace(a)) { "a" }
        checkHex32(eidNsec, "eid_nsec"); checkHex32(einboxNsec, "einbox_nsec"); checkHex32(grantedBy, "granted_by")
        eck.forEach { it.validate() }; checkList(configRelays, Limits.MAX_RELAYS, "config_relays")
    }
}

@Serializable
data class WithdrawalContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    @SerialName("delete_data") val deleteData: Boolean = true,
) : Validated {
    override fun validate() = checkVersion(v)
}

// ── Talks ────────────────────────────────────────────────────────────────

private fun validateTalkSource(media: MediaDescriptor?, externalUrl: String?, externalKind: String?) {
    check((media != null) != (externalUrl != null)) { "a talk needs exactly one of media or external_url" }
    if (media != null) { media.validate(); check(media.kind == "talk") { "talk media must be kind:'talk'" } }
    if (externalUrl != null) {
        check(externalUrl.length <= 2048 && isHttpsUrl(externalUrl)) { "external_url must be https" }
        check(externalKind == "youtube" || externalKind == "video") { "external_kind is required" }
    }
}

@Serializable
data class TalkSubmissionContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    @SerialName("talk_d") val talkD: String,
    val title: String,
    val description: String = "",
    val speakers: List<String> = emptyList(),
    val media: MediaDescriptor? = null,
    @SerialName("external_url") val externalUrl: String? = null,
    @SerialName("external_kind") val externalKind: String? = null,
    @SerialName("source_type") val sourceType: String? = null,
    @SerialName("process_for_matching") val processForMatching: Boolean = false,
    val revision: Long = 0,
) : Validated {
    override fun validate() {
        checkVersion(v); check(talkD.length in 1..64) { "talk_d" }
        check(title.length in 1..Limits.MAX_TALK_TITLE) { "title" }; checkLen(description, Limits.MAX_TALK_DESC, "description")
        speakers.forEach { checkHex32(it, "speakers") }
        check(sourceType == null || sourceType in setOf("recording", "upload", "external")) { "source_type" }
        check(revision >= 0) { "revision" }
        validateTalkSource(media, externalUrl, externalKind)
    }
}

@Serializable
data class TalkContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val pubkey: String,
    @SerialName("talk_d") val talkD: String,
    val title: String,
    val description: String = "",
    val speakers: List<String> = emptyList(),
    val media: MediaDescriptor? = null,
    @SerialName("external_url") val externalUrl: String? = null,
    @SerialName("external_kind") val externalKind: String? = null,
    @SerialName("source_type") val sourceType: String? = null,
    val transcript: MediaTranscript? = null,
    val lang: String,
    val revision: Long,
    val status: String,
    @SerialName("published_at") val publishedAt: Long,
) : Validated {
    override fun validate() {
        checkVersion(v); checkHex32(pubkey, "pubkey"); check(talkD.length in 1..64) { "talk_d" }
        check(title.length in 1..Limits.MAX_TALK_TITLE) { "title" }
        check(status in setOf("pending", "published", "rejected")) { "status" }
        transcript?.validate()
        validateTalkSource(media, externalUrl, externalKind)
    }
}

// ── Self copy, directory, roster, matches ────────────────────────────────

@Serializable
data class MyProfileContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String?,
    val profile: AttendeeProfile? = null,
    val media: List<MediaDescriptor> = emptyList(),
    @SerialName("intro_texts") val introTexts: List<String>? = null,
    val rev: Long? = null,
    @SerialName("correction_rev") val correctionRev: Long? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); profile?.validate()
        checkList(media, Limits.MAX_MEDIA, "media"); media.forEach { it.validate() }
        checkStrings(introTexts, Limits.MAX_LIBRARY_TEXTS, Limits.MAX_INTRO_TEXT, "intro_texts")
    }
}

@Serializable
data class DirectoryEntryContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val pubkey: String,
    val name: String? = null,
    val profile: AttendeeProfile,
    val media: List<MediaDescriptor> = emptyList(),
    @SerialName("ai_profile") val aiProfile: AiProfile? = null,
    @SerialName("ai_profile_edited") val aiProfileEdited: Boolean? = null,
    val transcripts: List<MediaTranscript>? = null,
    @SerialName("intro_text") val introText: String? = null,
    @SerialName("updated_at") val updatedAt: Long,
) : Validated {
    override fun validate() {
        checkVersion(v); checkHex32(pubkey, "pubkey"); checkLen(name, Limits.MAX_NAME, "name")
        profile.validate(); checkList(media, Limits.MAX_MEDIA, "media"); media.forEach { it.validate() }
        aiProfile?.validate(); checkList(transcripts, Limits.MAX_TRANSCRIPTS, "transcripts")
        val live = media.map { it.x }.toSet()
        transcripts?.forEach { it.validate(); check(it.x in live) { "transcript.x must reference a media descriptor" } }
        checkLen(introText, Limits.MAX_INTRO_TEXT, "intro_text")
    }
}

@Serializable
data class RosterChatKey(
    val pubkey: String,
    val label: String? = null,
    @SerialName("added_at") val addedAt: Long,
    val external: Boolean? = null,
)

@Serializable
data class RosterAttendee(
    val pubkey: String,
    val d: String,
    val role: String,
    @SerialName("chat_keys") val chatKeys: List<RosterChatKey>? = null,
)

@Serializable
data class RosterContent(
    val v: Int,
    @SerialName("eck_current") val eckCurrent: Int,
    @SerialName("nostr_group_id") val nostrGroupId: String? = null,
    val pages: Int? = null,
    val attendees: List<RosterAttendee>,
) : Validated {
    override fun validate() {
        check(v == Wire.PROTOCOL_VERSION || v == Wire.ROSTER_PAGED_VERSION) { "unsupported roster v $v" }
        check(eckCurrent > 0) { "eck_current" }; checkHex32(nostrGroupId, "nostr_group_id")
        check(pages == null || pages in 2..Limits.MAX_ROSTER_PAGES) { "pages" }
        check(pages == null || v == Wire.ROSTER_PAGED_VERSION) { "a paginated roster must declare v:3" }
        checkList(attendees, Limits.MAX_ROSTER_PAGE, "attendees")
        attendees.forEach {
            checkHex32(it.pubkey, "pubkey"); checkLen(it.d, Limits.MAX_D, "d")
            check(it.role == "attendee" || it.role == "organizer") { "role" }
            checkList(it.chatKeys, Limits.MAX_CHAT_KEYS_PER_ACCOUNT, "chat_keys")
            it.chatKeys?.forEach { k -> checkHex32(k.pubkey, "chat key"); checkLen(k.label, Limits.MAX_CHAT_KEY_LABEL, "label") }
        }
    }
}

@Serializable
data class Match(
    val pubkey: String,
    val score: Double,
    val similarity: Double,
    val complementarity: Double,
    val reasoning: String,
    val icebreakers: List<String>? = null,
)

@Serializable
data class MatchListContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    @SerialName("computed_at") val computedAt: Long,
    val matches: List<Match>,
) : Validated {
    override fun validate() {
        checkVersion(v); checkList(matches, Limits.MAX_MATCHES, "matches")
        matches.forEach {
            checkHex32(it.pubkey, "pubkey"); checkLen(it.reasoning, Limits.MAX_REASONING, "reasoning")
            checkStrings(it.icebreakers, Limits.MAX_ICEBREAKERS, Limits.MAX_ICEBREAKER, "icebreakers")
        }
    }
}

@Serializable
data class MatchPair(val a: String, val b: String, val score: Double)

@Serializable
data class MatchMatrixContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    @SerialName("computed_at") val computedAt: Long,
    val pairs: List<MatchPair>,
) : Validated {
    override fun validate() { checkVersion(v); checkList(pairs, 200_000, "pairs") }
}

// ── Posts and the event page ─────────────────────────────────────────────

@Serializable
data class MembersPostContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val title: String,
    val summary: String? = null,
    val image: String? = null,
    @SerialName("published_at") val publishedAt: Long,
    val author: String? = null,
    val content: String,
) : Validated {
    override fun validate() {
        checkVersion(v); checkLen(title, Limits.MAX_TITLE, "title"); checkLen(summary, Limits.MAX_MESSAGE, "summary")
        check(image == null || isHttpsUrl(image)) { "image" }; checkHex32(author, "author")
        checkLen(content, Limits.MAX_POST_BODY, "content")
    }
}

@Serializable
@JsonClassDiscriminator("type")
sealed class PageSection {
    abstract val pos: Int?

    @Serializable @SerialName("posts")
    data class Posts(val source: String, val visibility: String, override val pos: Int? = null) : PageSection()

    @Serializable @SerialName("pinned")
    data class Pinned(val refs: List<String>, override val pos: Int? = null) : PageSection()

    @Serializable @SerialName("attendees")
    data class Attendees(override val pos: Int? = null) : PageSection()

    fun withPos(p: Int?): PageSection = when (this) {
        is Posts -> copy(pos = p)
        is Pinned -> copy(pos = p)
        is Attendees -> copy(pos = p)
    }
}

@Serializable
data class MenuItem(val label: String, val target: String, val pos: Int? = null)

@Serializable
data class ExternalFeed(
    val pubkey: String,
    val tags: List<String>? = null,
    val since: Long? = null,
    val until: Long? = null,
    val relays: List<String>? = null,
    val label: String? = null,
)

@Serializable
data class EventPagePrivate(
    val v: Int = Wire.PROTOCOL_VERSION,
    val menu: List<MenuItem> = emptyList(),
    val sections: List<PageSection> = emptyList(),
) : Validated {
    override fun validate() {
        checkVersion(v); checkList(menu, Limits.MAX_PAGE_SECTIONS, "menu"); checkList(sections, Limits.MAX_PAGE_SECTIONS, "sections")
    }
}

@Serializable
data class EventPageContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val sections: List<PageSection> = emptyList(),
    val sources: List<ExternalFeed> = emptyList(),
    val private: String? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); checkList(sources, Limits.MAX_FEED_SOURCES, "sources")
        sources.forEach { checkHex32(it.pubkey, "source pubkey") }
    }
}

// ── Self-encrypted app data (30078) ──────────────────────────────────────

@Serializable
data class PerEventSettings(
    val v: Int = Wire.PROTOCOL_VERSION,
    val favorites: List<String> = emptyList(),
    @SerialName("want_to_meet") val wantToMeet: List<String> = emptyList(),
    val met: List<String> = emptyList(),
    val notes: Map<String, String> = emptyMap(),
) : Validated {
    override fun validate() {
        checkVersion(v)
        for (l in listOf(favorites, wantToMeet, met)) { checkList(l, Limits.MAX_ROSTER, "list"); l.forEach { checkHex32(it, "pubkey") } }
        check(notes.size <= Limits.MAX_NOTES) { "too many notes" }; notes.values.forEach { checkLen(it, Limits.MAX_NOTE, "note") }
    }
}

@Serializable
data class DmReadPosition(val at: Long, val id: String)

@Serializable
data class DmReadState(val v: Int = Wire.PROTOCOL_VERSION, val threads: Map<String, DmReadPosition> = emptyMap()) : Validated {
    override fun validate() {
        checkVersion(v); check(threads.size <= Limits.MAX_DM_READ_THREADS) { "too many read threads" }
        threads.forEach { (k, p) -> checkHex32(k, "thread"); checkHex32(p.id, "id"); check(p.at >= 0) { "at" } }
    }
}

@Serializable
data class EventKeysBackup(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String? = null,
    @SerialName("eid_nsec") val eidNsec: String,
    @SerialName("einbox_nsec") val einboxNsec: String,
    val eck: List<EckVersion>,
    @SerialName("coordinator_gen") val coordinatorGen: Int? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); checkHex32(eidNsec, "eid_nsec"); checkHex32(einboxNsec, "einbox_nsec"); eck.forEach { it.validate() }
    }
}

// ── Coordinator ──────────────────────────────────────────────────────────

@Serializable
data class CoordinatorBilling(
    val state: String,
    val reason: String? = null,
    @SerialName("checkout_url") val checkoutUrl: String? = null,
    val due: Double? = null,
    val currency: String? = null,
    @SerialName("grace_until") val graceUntil: Long? = null,
)

@Serializable
data class CoordinatorStatusContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    val pubkey: String? = null,
    val stage: String? = null,
    val state: String? = null,
    val attempts: Int? = null,
    @SerialName("error_category") val errorCategory: String? = null,
    val retryable: Boolean? = null,
    val billing: CoordinatorBilling? = null,
    val at: Long,
) : Validated {
    override fun validate() {
        checkVersion(v); checkHex32(pubkey, "pubkey")
        check(state == null || state == "poison" || state == "cleared") { "state" }
        check(billing == null || billing.state in setOf("ok", "payment_required", "grace")) { "billing state" }
        check(billing?.checkoutUrl == null || isHttpsUrl(billing.checkoutUrl)) { "checkout_url" }
    }
}

@Serializable
data class CoordinatorPricing(
    val model: String,
    @SerialName("free_up_to_users") val freeUpToUsers: Int? = null,
    val summary: String? = null,
    @SerialName("checkout_url") val checkoutUrl: String? = null,
    val currency: String? = null,
)

@Serializable
data class CoordinatorFeatures(val matching: Boolean = true, val talks: Boolean = false, val chat: List<String> = emptyList())

@Serializable
data class CoordinatorAnnounce(
    val v: Int = Wire.PROTOCOL_VERSION,
    val name: String,
    val about: String? = null,
    val picture: String? = null,
    val operator: String? = null,
    val relays: List<String> = emptyList(),
    val features: CoordinatorFeatures = CoordinatorFeatures(),
    val privacy: Map<String, String>? = null,
    @SerialName("terms_url") val termsUrl: String? = null,
    val pricing: CoordinatorPricing? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); check(name.length in 1..120) { "name" }; checkLen(about, 2000, "about")
        check(picture == null || isHttpsUrl(picture)) { "picture" }
        check(termsUrl == null || isHttpsUrl(termsUrl)) { "terms_url" }
    }
}

// ── Chat attestation (21607) ─────────────────────────────────────────────

@Serializable
data class ChatKeyAttestationContent(
    val v: Int = Wire.PROTOCOL_VERSION,
    val a: String,
    val op: String,
    @SerialName("chat_pubkey") val chatPubkey: String,
    val label: String? = null,
    @SerialName("client_id") val clientId: String? = null,
    val proof: String? = null,
    val code: String? = null,
) : Validated {
    override fun validate() {
        checkVersion(v); check(op in setOf("add", "revoke", "link", "link_confirm")) { "op" }
        checkHex32(chatPubkey, "chat_pubkey"); checkLen(label, Limits.MAX_CHAT_KEY_LABEL, "label")
        checkLen(clientId, Limits.MAX_CHAT_KEY_CLIENT_ID, "client_id")
        check(proof == null || proof.isHex64()) { "proof" }
        check(code == null || code.length in 1..Limits.MAX_CHAT_LINK_CODE_INPUT) { "code" }
        check(code == null || op == "link_confirm") { "code is only valid on op:'link_confirm'" }
        when (op) {
            "link" -> { check(proof == null) { "proof is not used on link" }; check(label != null) { "label is required for link" } }
            "link_confirm" -> { check(proof == null) { "proof is not used on link_confirm" }; check(code != null) { "code is required" } }
            "add" -> { check(proof != null) { "proof of possession is required for add" }; check(label != null) { "label is required for add" } }
        }
    }

    companion object {
        fun normalizeLinkCode(input: String) = input.uppercase().replace(Regex("[\\s.-]"), "")
    }
}

/** `{"v":2,...}` payload as a JSON object, for the rare places that need raw access. */
fun jsonObjectOf(text: String): JsonObject? = runCatching { Wire.json.parseToJsonElement(text) as JsonObject }.getOrNull()
