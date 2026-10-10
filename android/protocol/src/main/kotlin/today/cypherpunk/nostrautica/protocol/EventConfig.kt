package today.cypherpunk.nostrautica.protocol

import java.net.URI

/** Kind 31600 Event Networking Config (config.ts): everything lives in tags. */
data class EventConfig(
    val d: String,
    val eidPubkey: String,
    val inbox: String,
    val coordinator: String? = null,
    val coordinatorGen: Int? = null,
    val relays: List<String> = emptyList(),
    val chatRelays: List<String> = emptyList(),
    val blossom: List<String> = emptyList(),
    /** Seconds; 0 = unlimited. */
    val maxVideoSec: Int = 90,
    val maxTalkSec: Int = 900,
    val matching: Boolean = false,
    val matchVisibility: String = "pair",
    /** manual | invite | manual+invite | open */
    val approval: String = "manual",
    val eck: Int = 1,
    val nostrContext: Int = 0,
    val lang: String = "en",
    /** off | on | prerecord-first */
    val talks: String = "off",
    val chat: List<String> = emptyList(),
    val retentionDays: Int? = null,
) {
    /** The coordinate of a dated event; communities are built with [coordinate] and their kind. */
    fun coordinate(kind: Int = Kinds.CALENDAR_EVENT) = Coordinate(kind, eidPubkey, d)

    /** Chat is operative only with a coordinator (the MLS admin bot). */
    val isMarmotChatEnabled: Boolean get() = coordinator != null && "marmot" in chat

    fun toTags(kind: Int = Kinds.CALENDAR_EVENT): List<List<String>> {
        val tags = mutableListOf(
            listOf("d", d),
            listOf("a", coordinate(kind).toString()),
            listOf("v", Wire.PROTOCOL_VERSION_TAG),
            listOf("inbox", inbox),
        )
        if (coordinator != null) {
            require(coordinatorGen != null && coordinatorGen >= 1) { "31600 config: coordinator requires a positive integer coordinatorGen" }
            tags += listOf("coordinator", coordinator, coordinatorGen.toString())
        }
        relays.forEach { tags += listOf("relay", it) }
        chatRelays.forEach { tags += listOf("chat_relay", it) }
        blossom.forEach { tags += listOf("blossom", it) }
        tags += listOf("max_video_sec", maxVideoSec.toString())
        tags += listOf("max_talk_sec", maxTalkSec.toString())
        tags += listOf("matching", if (matching) "on" else "off")
        tags += listOf("match_visibility", matchVisibility)
        tags += listOf("approval", approval)
        tags += listOf("eck", eck.toString())
        tags += listOf("nostr_context", nostrContext.toString())
        val l = normalizeLang(lang)
        if (l != "en") tags += listOf("lang", l)
        if (talks != "off") tags += listOf("talks", talks)
        chat.filter { it in BACKENDS }.forEach { tags += listOf("chat", it) }
        if (retentionDays != null) {
            require(retentionDays >= 1) { "31600 config: retentionDays must be a positive integer" }
            tags += listOf("retention", retentionDays.toString())
        }
        return tags
    }

    companion object {
        const val UNLIMITED_SEC = 0
        val APPROVALS = listOf("manual", "invite", "manual+invite", "open")
        val TALKS_MODES = listOf("off", "on", "prerecord-first")
        private val BACKENDS = listOf("marmot")

        /** Relays that exist only for White Noise interop; they refuse every non-chat kind. */
        val CHAT_INTEROP_RELAYS = listOf("wss://relay.us.whitenoise.chat", "wss://relay.eu.whitenoise.chat")
        private val CHAT_INTEROP_HOSTS = CHAT_INTEROP_RELAYS.map { URI(it).host }.toSet()

        fun isChatInteropRelay(url: String): Boolean =
            runCatching { URI(url).host?.lowercase() in CHAT_INTEROP_HOSTS }.getOrDefault(false)

        fun normalizeLang(lang: String?): String {
            val base = (lang ?: "en").trim().lowercase().split('-', '_').first()
            return if (Regex("^[a-z]{2}$").matches(base)) base else "en"
        }

        private fun first(tags: List<List<String>>, name: String) = tags.firstOrNull { it.size >= 2 && it[0] == name }?.get(1)
        private fun all(tags: List<List<String>>, name: String) = tags.filter { it.size >= 2 && it[0] == name }.map { it[1] }.filter { it.isNotEmpty() }

        private fun urlValues(tags: List<List<String>>, name: String, scheme: String) =
            all(tags, name).filter { runCatching { URI(it).scheme == scheme && !URI(it).host.isNullOrEmpty() }.getOrDefault(false) }

        private fun intTag(tags: List<List<String>>, name: String, def: Int): Int {
            val raw = first(tags, name) ?: return def
            if (raw.isBlank()) return def
            val n = raw.trim().toDoubleOrNull() ?: return def
            return if (n.isFinite() && n >= 0) kotlin.math.floor(n).toInt() else def
        }

        /**
         * Parse a 31600 (config.ts parseEventConfig): `d` and `inbox` required, the
         * rest fail-soft to documented defaults. A newer `v` tag throws
         * [Wire.NewerProtocolVersion] so the app can ask for an update.
         */
        fun parse(eidPubkey: String, tags: List<List<String>>): EventConfig {
            val d = first(tags, "d")
            val inbox = first(tags, "inbox")?.takeIf { it.isHex32() }
            require(!d.isNullOrEmpty() && inbox != null) { "31600 config missing d or inbox" }
            val v = Wire.eventVersionTag(tags)
            if (v != null && v > Wire.PROTOCOL_VERSION) throw Wire.NewerProtocolVersion(v)
            require(v == Wire.PROTOCOL_VERSION) { "31600 config: unsupported v tag ${v ?: "<absent>"}" }

            val coordTag = tags.firstOrNull { it.isNotEmpty() && it[0] == "coordinator" }
            var coordinator: String? = null
            var gen: Int? = null
            if (coordTag != null && coordTag.size >= 3 && coordTag[1].isHex32()) {
                coordTag[2].toIntOrNull()?.takeIf { it >= 1 }?.let { coordinator = coordTag[1]; gen = it }
            }
            val relayTags = urlValues(tags, "relay", "wss")
            val chatRelays = LinkedHashSet<String>().apply {
                addAll(urlValues(tags, "chat_relay", "wss"))
                addAll(relayTags.filter(::isChatInteropRelay))
            }
            val chat = all(tags, "chat").filter { it in BACKENDS }.distinct()
            return EventConfig(
                d = d!!,
                eidPubkey = eidPubkey,
                inbox = inbox,
                coordinator = coordinator,
                coordinatorGen = gen,
                relays = relayTags.filterNot(::isChatInteropRelay),
                chatRelays = chatRelays.toList(),
                blossom = urlValues(tags, "blossom", "https"),
                maxVideoSec = intTag(tags, "max_video_sec", 90),
                maxTalkSec = intTag(tags, "max_talk_sec", 900),
                matching = first(tags, "matching") == "on",
                matchVisibility = first(tags, "match_visibility").takeIf { it == "pair" || it == "event" } ?: "pair",
                approval = first(tags, "approval").takeIf { it in APPROVALS } ?: "manual",
                eck = maxOf(1, intTag(tags, "eck", 1)),
                nostrContext = intTag(tags, "nostr_context", 0),
                lang = normalizeLang(first(tags, "lang")),
                talks = first(tags, "talks").takeIf { it in TALKS_MODES } ?: "off",
                chat = chat,
                retentionDays = first(tags, "retention")?.toIntOrNull()?.takeIf { it >= 1 },
            )
        }

        fun parse(event: NostrEvent): EventConfig = parse(event.pubkey, event.tags)
    }
}
