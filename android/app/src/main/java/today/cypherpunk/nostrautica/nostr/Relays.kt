package today.cypherpunk.nostrautica.nostr

import today.cypherpunk.nostrautica.protocol.EventConfig

/** Relay and Blossom defaults (packages/app/src/lib/nostr/relays.ts). */
object Relays {
    private val DEV = today.cypherpunk.nostrautica.BuildConfig.DEV_RELAYS.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    private val DEV_BLOSSOM = today.cypherpunk.nostrautica.BuildConfig.DEV_BLOSSOM.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    val DEFAULT = DEV.ifEmpty {
        listOf(
            "wss://nostr.cypherpunk.today",
            "wss://nos.lol",
            "wss://relay.primal.net",
            "wss://nostr.mom",
            "wss://nostr.oxtr.dev",
        )
    }
    val DEFAULT_READ = if (DEV.isNotEmpty()) emptyList() else listOf("wss://purplerelay.com")
    val READ: List<String> get() = DEFAULT + DEFAULT_READ

    /** Where a NIP-46 signer and the app meet: several operators, so one outage doesn't strand a login. */
    val NIP46 = DEV.ifEmpty { listOf("wss://nostr.cypherpunk.today", "wss://relay.primal.net", "wss://nos.lol") }

    /** Our 10050 for generated keys. */
    val DM_RELAY_LIST = DEV.ifEmpty { listOf("wss://nostr.cypherpunk.today", "wss://relay.primal.net", "wss://nos.lol") }

    data class RelayListEntry(val url: String, val read: Boolean, val write: Boolean)

    /** The 10002 published for a brand-new identity. */
    val ONBOARDING = if (DEV.isNotEmpty()) DEV.map { RelayListEntry(it, true, true) } else listOf(
        RelayListEntry("wss://nostr.cypherpunk.today", true, true),
        RelayListEntry("wss://nos.lol", true, true),
        RelayListEntry("wss://relay.primal.net", true, true),
        RelayListEntry("wss://nostr.mom", true, true),
        RelayListEntry("wss://nostr.oxtr.dev", true, false),
    )

    val CHAT_INTEROP = EventConfig.CHAT_INTEROP_RELAYS

    val BLOSSOM = DEV_BLOSSOM.ifEmpty { listOf("https://blossom.band", "https://nostr.download") }

    const val MAX_DM_RELAYS = 20

    /**
     * relays.ts isAcceptedRelayUrl, the one implementation in the app: `wss://`, or
     * `ws://` to this machine only (the dev stack). Plaintext to a remote host would
     * expose the traffic and its metadata to anyone on the path.
     */
    fun isAccepted(url: String): Boolean {
        val u = runCatching { java.net.URI(url.trim()) }.getOrNull() ?: return false
        return when (u.scheme?.lowercase()) {
            "wss" -> !u.host.isNullOrEmpty()
            "ws" -> u.host in LOOPBACK
            else -> false
        }
    }

    private val LOOPBACK = setOf("localhost", "127.0.0.1", "[::1]", "::1")

    /**
     * Relays from a source someone else controls (an naddr's hints, a config or a
     * grant's `config_relays`, a pasted pointer): normalized, and dropped unless
     * [isAccepted] (audit R-66/R-78). Dropped, not deprioritised.
     */
    fun accepted(urls: List<String>): List<String> = urls.map(RelayPool::normalize).filter(::isAccepted).distinct()

    /** An event's relays: defaults ∪ its 31600 relays ∪ naddr hints. Never the chat-only interop relays. */
    fun forEvent(config: EventConfig?, hints: List<String> = emptyList()): List<String> =
        (DEFAULT.map(RelayPool::normalize) + accepted((config?.relays ?: emptyList()) + hints.filterNot(EventConfig::isChatInteropRelay))).distinct()

    fun forEventRead(config: EventConfig?, hints: List<String> = emptyList()): List<String> =
        (forEvent(config, hints) + DEFAULT_READ.map(RelayPool::normalize)).distinct()

    /** Chat traffic goes to the event's relays ∪ its chat relays. */
    fun forChat(config: EventConfig?): List<String> =
        (forEvent(config) + accepted(config?.chatRelays ?: CHAT_INTEROP)).distinct()
}
