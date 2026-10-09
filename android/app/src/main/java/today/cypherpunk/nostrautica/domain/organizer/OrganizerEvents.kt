package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.EventKeysBackup
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Roster
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.nowSec

/** The create form's answers (create.ts CreateEventInput). */
data class CreateEventInput(
    val title: String,
    val summary: String,
    /** Unix seconds; null for a community (31612 has no time semantics). */
    val start: Long? = null,
    val end: Long? = null,
    val location: String? = null,
    val icon: String? = null,
    val banner: String? = null,
    val hashtags: List<String> = emptyList(),
    val maxVideoSec: Int = 90,
    val maxTalkSec: Int = 900,
    val matching: Boolean = true,
    val matchVisibility: String = "pair",
    val approval: String = "manual+invite",
    val community: Boolean = false,
    val nostrContext: Int = 100,
    val lang: String = "en",
    val talks: String = "off",
    val chat: List<String> = emptyList(),
    val relays: List<String> = emptyList(),
    val blossom: List<String> = emptyList(),
)

/**
 * Pure builders for everything an organizer signs with E_id. No network here, so
 * the exact wire output (and that a created 31600 parses back) is unit-tested.
 */
object OrganizerEvents {
    /** NIP-52 `D` day tags are capped (audit P8). */
    const val MAX_DAY_TAGS = 60

    /**
     * One `D` tag per UTC day in the half-open range [start, end): an end exactly
     * at midnight does not tag the next day. Decimal day number, not ISO (R5).
     */
    fun dayIndexTags(start: Long, end: Long?): List<List<String>> {
        val startDay = Math.floorDiv(start, 86400L)
        val endDay = if (end != null && end > start) maxOf(startDay, Math.floorDiv(end - 1, 86400L)) else startDay
        val out = mutableListOf<List<String>>()
        var day = startDay
        while (day <= endDay && out.size < MAX_DAY_TAGS) { out += listOf("D", day.toString()); day++ }
        return out
    }

    /** create.ts slug: ascii-folded title plus 4 random bytes. */
    fun slug(title: String, rand: ByteArray = Bytes.random(4)): String {
        val base = title.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
        return "${base.ifEmpty { "event" }}-${Bytes.toHex(rand)}"
    }

    data class Created(
        val coordinate: String,
        val naddr: String,
        val eidPubkey: String,
        val inboxPubkey: String,
        val eidNsecHex: String,
        val einboxNsecHex: String,
        val eck: EckVersion,
        val config: EventConfig,
        val kind0: NostrEvent,
        val space: NostrEvent,
        val configEvent: NostrEvent,
        val backup: EventKeysBackup,
    )

    /**
     * create.ts createEvent minus the publishing: mint E_id, E_inbox and ECK v1; sign
     * kind 0, the 31923/31612 and the 31600 with E_id. Chat relays go into the
     * separate `chat_relay` set, never into `relays` (they refuse every other kind).
     */
    fun buildCreate(
        input: CreateEventInput,
        eidSk: ByteArray = Secp.generateSecret(),
        einboxSk: ByteArray = Secp.generateSecret(),
        eck: ByteArray = Bytes.random(32),
        d: String = slug(input.title),
        now: Long = nowSec(),
    ): Created {
        val eidPub = Secp.pubkeyHex(eidSk)
        val inboxPub = Secp.pubkeyHex(einboxSk)
        val kind = if (input.community) Kinds.COMMUNITY else Kinds.CALENDAR_EVENT
        val coordinate = Coordinate(kind, eidPub, d).toString()
        val relays = input.relays.ifEmpty { Relays.DEFAULT }
        val chatRelays = if (input.chat.isNotEmpty()) chatInteropRelays(relays) else emptyList()

        val profile = buildJsonObject {
            put("name", JsonPrimitive(input.title))
            put("about", JsonPrimitive(input.summary))
            input.icon?.let { put("picture", JsonPrimitive(it)) }
            input.banner?.let { put("banner", JsonPrimitive(it)) }
        }
        val kind0 = UnsignedEvent(eidPub, now, Kinds.PROFILE, emptyList(), JsJson.stringify(profile)).signWith(eidSk)

        val tags = mutableListOf(listOf("d", d), listOf("title", input.title))
        if (input.start != null) {
            tags += listOf("start", input.start.toString())
            if (input.end != null && input.end != 0L) tags += listOf("end", input.end.toString())
            tags += dayIndexTags(input.start, input.end)
        }
        if (input.summary.isNotEmpty()) tags += listOf("summary", input.summary)
        input.banner?.let { tags += listOf("image", it) }
        input.location?.let { tags += listOf("location", it) }
        input.hashtags.forEach { tags += listOf("t", it) }
        val space = UnsignedEvent(eidPub, now, kind, tags, input.summary).signWith(eidSk)

        val config = EventConfig(
            d = d, eidPubkey = eidPub, inbox = inboxPub, relays = relays, chatRelays = chatRelays,
            blossom = input.blossom, maxVideoSec = input.maxVideoSec, maxTalkSec = input.maxTalkSec,
            matching = input.matching, matchVisibility = input.matchVisibility, approval = input.approval,
            eck = 1, nostrContext = input.nostrContext, lang = input.lang, talks = input.talks, chat = input.chat,
        )
        val configEvent = UnsignedEvent(eidPub, now, Kinds.EVENT_CONFIG, configTags(config), "").signWith(eidSk)
        val eckV = EckVersion(1, Bytes.toBase64(eck))
        val backup = EventKeysBackup(a = coordinate, eidNsec = Bytes.toHex(eidSk), einboxNsec = Bytes.toHex(einboxSk), eck = listOf(eckV))
        return Created(
            coordinate, Coordinate(kind, eidPub, d).toNaddr(relays), eidPub, inboxPub, Bytes.toHex(eidSk), Bytes.toHex(einboxSk),
            eckV, config, kind0, space, configEvent, backup,
        )
    }

    /**
     * The 31600 tags. Matches the PWA's buildEventConfig, which always names the
     * `a` coordinate with kind 31923 (also for a community): readers key the config
     * by its `d` + author, and diverging here would make the two apps' configs differ.
     */
    fun configTags(config: EventConfig): List<List<String>> = config.toTags()

    /** relays.ts chatInteropRelays: the White Noise pair, unless the event is local-only (tests). */
    fun chatInteropRelays(relays: List<String>): List<String> {
        val localOnly = relays.isNotEmpty() && relays.all { r ->
            runCatching { java.net.URI(r).host in setOf("localhost", "127.0.0.1", "::1", "[::1]") }.getOrDefault(false)
        }
        return if (localOnly) emptyList() else EventConfig.CHAT_INTEROP_RELAYS
    }

    /** ndk.ts isAcceptedRelayUrl: wss://, or ws:// to this machine only. */
    fun isAcceptedRelayUrl(url: String): Boolean = runCatching {
        val u = java.net.URI(url)
        when (u.scheme) {
            "wss" -> !u.host.isNullOrEmpty()
            "ws" -> u.host in setOf("localhost", "127.0.0.1", "[::1]", "::1")
            else -> false
        }
    }.getOrDefault(false)

    fun unionRelays(vararg lists: List<String>): List<String> =
        lists.flatMap { it }.map { it.trim().trimEnd('/') }.filter { it.isNotEmpty() }.distinct()

    // ── Roster rewrite (organizer.ts loadRoster / rosterForRewrite / buildRosterEvents) ──

    sealed interface RosterRead {
        data class Ok(val roster: RosterContent, val at: Long) : RosterRead
        /** Nothing came back; [suspect] when this device has seen a roster before. */
        data class Absent(val suspect: Boolean) : RosterRead
        data class Unreadable(val at: Long) : RosterRead
    }

    class RosterUnreadable : Exception(
        "Couldn't read this event's current roster, so nothing was published. " +
            "Rewriting it now would remove everyone already approved. Check your connection and try again.",
    )

    /** Only a genuine first roster (nothing came back, never seen one) may be rewritten from empty. */
    fun rosterForRewrite(read: RosterRead, eckCurrent: Int): Pair<RosterContent, Long> = when (read) {
        is RosterRead.Ok -> read.roster to read.at
        is RosterRead.Unreadable -> throw RosterUnreadable()
        is RosterRead.Absent -> if (read.suspect) throw RosterUnreadable() else RosterContent(2, eckCurrent, null, null, emptyList()) to 0L
    }

    private fun rosterJson(r: RosterContent) = Wire.json.encodeToString(RosterContent.serializer(), r)

    /**
     * The 31604 page(s) for [roster], strictly newer than [baseCreatedAt]. With
     * [previous], a page whose bytes are unchanged is not republished, so an
     * approval costs one publish rather than N.
     */
    fun buildRosterEvents(
        coordinate: String,
        eidSk: ByteArray,
        eck: ByteArray,
        eckId: Int,
        roster: RosterContent,
        baseCreatedAt: Long = 0,
        previous: RosterContent? = null,
        now: Long = nowSec(),
    ): List<NostrEvent> {
        val identifier = Coordinate.parse(coordinate).identifier
        val pages = Roster.split(roster.copy(eckCurrent = eckId))
        val onRelay = previous?.let { runCatching { Roster.split(it.copy(eckCurrent = eckId)).map(::rosterJson) }.getOrDefault(emptyList()) } ?: emptyList()
        val createdAt = maxOf(now, baseCreatedAt + 1)
        val eid = Secp.pubkeyHex(eidSk)
        return pages.mapIndexedNotNull { page, content ->
            val json = rosterJson(content)
            if (onRelay.getOrNull(page) == json) return@mapIndexedNotNull null
            UnsignedEvent(
                eid, createdAt, Kinds.ROSTER,
                listOf(listOf("d", Roster.pageD(identifier, page)), listOf("a", coordinate), listOf("eck", eckId.toString()), listOf("v", "2")),
                Nip44.eckEncrypt(eck, json),
            ).signWith(eidSk)
        }
    }

    /** The next ECK version (forward-only rotation, §6.3): id = max + 1, fresh random key. */
    fun nextEck(existing: List<EckVersion>, key: ByteArray = Bytes.random(32)) =
        EckVersion((existing.maxOfOrNull { it.id } ?: 0) + 1, Bytes.toBase64(key))

    /** Every remaining member's blinded `d` re-derived under the new ECK (roles and chat keys kept). */
    fun rederive(coordinate: String, attendees: List<RosterAttendee>, newEck: ByteArray) =
        attendees.map { it.copy(d = ProtocolCrypto.blindedD(newEck, coordinate, it.pubkey)) }

    /** A rumor content object as JSON text, the way every payload goes on the wire. */
    fun json(o: JsonObject): String = JsJson.stringify(o)
}
