package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.jsonObjectOf

/** Everything public about an event (events/event-context.ts). */
@Serializable
data class EventContext(
    val naddr: String,
    val coordinate: String,
    val config: SerializableConfig,
    val title: String,
    val summary: String = "",
    val start: Long? = null,
    val end: Long? = null,
    val icon: String? = null,
    val banner: String? = null,
    val location: String? = null,
    val hashtags: List<String> = emptyList(),
    val configAt: Long = 0,
    val contextAt: Long = 0,
) {
    val cfg: EventConfig get() = config.toConfig()
    val coord: Coordinate get() = Coordinate.parse(coordinate)
    val isCommunity: Boolean get() = coord.isCommunity
    val relays: List<String> get() = Relays.forEvent(cfg)
}

/** EventConfig with a stable serial form for the cache. */
@Serializable
data class SerializableConfig(val eidPubkey: String, val tags: List<List<String>>) {
    fun toConfig(): EventConfig = EventConfig.parse(eidPubkey, tags)
}

class UpdateRequired : Exception("This event needs a newer version of the app")

/**
 * Loading an event's public context: the 31600 config, the 31923/31612 itself
 * and E_id's kind-0 (icon, banner). Cache first; the network only when the cached
 * copy is older than [TTL_MS]. The config is the root of trust, so every
 * candidate is signature-verified (the pool does) and author-checked here.
 */
class EventContexts(private val nostr: Nostr, private val cache: Cache) {
    private val inflight = HashMap<String, Mutex>()

    private fun key(naddr: String) = "ctx:$naddr"
    private fun hintsKey(coordinate: String) = "relayhints:$coordinate"

    suspend fun cached(naddr: String): EventContext? = cache.get(Cache.ANON, key(naddr), EventContext.serializer())

    fun observe(naddr: String): Flow<EventContext?> = cache.observe(Cache.ANON, key(naddr), EventContext.serializer())

    suspend fun relayHints(coordinate: String): List<String> =
        cache.get(Cache.ANON, hintsKey(coordinate), ListSerializer(String.serializer())) ?: emptyList()

    /** Cached if fresh enough, else from relays (falling back to the cached copy offline). */
    suspend fun get(naddr: String, force: Boolean = false): EventContext {
        val cached = cached(naddr)
        if (!force && cached != null && cache.isFresh(key(naddr), TTL_MS)) return cached
        val m = synchronized(inflight) { inflight.getOrPut(naddr) { Mutex() } }
        return m.withLock {
            if (!force && cache.isFresh(key(naddr), TTL_MS)) cached(naddr)?.let { return@withLock it }
            runCatching { load(naddr) }.getOrElse { e -> cached ?: throw e }
        }
    }

    /** From a coordinate (Home has coordinates, not naddrs). */
    suspend fun forCoordinate(coordinate: String, force: Boolean = false): EventContext {
        val hints = relayHints(coordinate)
        return get(Coordinate.parse(coordinate).toNaddr(hints.take(2)), force)
    }

    suspend fun load(naddr: String): EventContext {
        val (coord, hints) = runCatching { Coordinate.fromNaddr(naddr.trim()) }.getOrElse { throw IllegalArgumentException("error.badEventLink") }
        val relays = Relays.forEventRead(null, hints)
        nostr.fetch(
            relays,
            Filter(kinds = listOf(Kinds.EVENT_CONFIG), authors = listOf(coord.pubkey), tags = mapOf("d" to listOf(coord.identifier))),
            Filter(kinds = listOf(coord.kind), authors = listOf(coord.pubkey), tags = mapOf("d" to listOf(coord.identifier))),
            Filter(kinds = listOf(Kinds.PROFILE), authors = listOf(coord.pubkey)),
        )
        return fromStore(naddr, coord) ?: throw IllegalStateException("event not found")
    }

    /** Build the context from whatever the store holds (also used offline). */
    private suspend fun fromStore(naddr: String, coord: Coordinate): EventContext? {
        val configEvent = nostr.store.latest(Kinds.EVENT_CONFIG, coord.pubkey, coord.identifier) ?: return null
        val config = try {
            EventConfig.parse(configEvent)
        } catch (e: Wire.NewerProtocolVersion) {
            throw UpdateRequired()
        }
        if (config.relays.isNotEmpty()) {
            cache.put(Cache.ANON, hintsKey(coord.toString()), ListSerializer(String.serializer()), config.relays, configEvent.createdAt)
        }
        val evt = nostr.store.latest(coord.kind, coord.pubkey, coord.identifier)
        val profile = nostr.store.latest(Kinds.PROFILE, coord.pubkey)
        val kind0 = profile?.content?.let(::jsonObjectOf) ?: JsonObject(emptyMap())
        fun k0(name: String) = (kind0[name] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
        val ctx = EventContext(
            naddr = naddr,
            coordinate = coord.toString(),
            config = SerializableConfig(configEvent.pubkey, configEvent.tags),
            title = evt?.tag("title") ?: k0("display_name") ?: k0("name") ?: "Untitled event",
            summary = evt?.tag("summary") ?: k0("about") ?: "",
            start = evt?.tag("start")?.toLongOrNull()?.takeIf { it > 0 },
            end = evt?.tag("end")?.toLongOrNull()?.takeIf { it > 0 },
            icon = k0("picture"),
            banner = evt?.tag("image") ?: k0("banner"),
            location = evt?.tag("location"),
            hashtags = evt?.tagValues("t") ?: emptyList(),
            configAt = configEvent.createdAt,
            contextAt = maxOf(configEvent.createdAt, evt?.createdAt ?: 0, profile?.createdAt ?: 0),
        )
        cache.put(Cache.ANON, key(naddr), EventContext.serializer(), ctx, ctx.contextAt)
        cache.markFetched(key(naddr))
        return ctx
    }

    /** After the organizer edits something, write the new state through. */
    suspend fun invalidate(naddr: String) = cache.forget(key(naddr))

    /** Latest signed 31600 for a coordinate (grant authentication needs the live config). */
    suspend fun fetchConfig(coordinate: String, extraRelays: List<String> = emptyList()): EventConfig? {
        val c = Coordinate.parseOrNull(coordinate) ?: return null
        val relays = Relays.forEventRead(null, relayHints(coordinate) + extraRelays)
        nostr.fetch(relays, Filter(kinds = listOf(Kinds.EVENT_CONFIG), authors = listOf(c.pubkey), tags = mapOf("d" to listOf(c.identifier))))
        val e = nostr.store.latest(Kinds.EVENT_CONFIG, c.pubkey, c.identifier) ?: return null
        return runCatching { EventConfig.parse(e) }.getOrNull()
    }

    companion object {
        const val TTL_MS = 5 * 60_000L

        fun latest(events: List<NostrEvent>) = Ordering.pickLatest(events)
    }
}
