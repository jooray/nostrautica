package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.AppPrefs
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.jsonObjectOf
import today.cypherpunk.nostrautica.protocol.nowSec
import kotlinx.serialization.json.JsonPrimitive

/** The user's relationship to one event, as Home lists it. */
enum class Role { VISITOR, PENDING, ATTENDEE, ORGANIZER }

/**
 * "Your events" (stores/recent-events + events/membership.ts + join-sent):
 * events this device holds keys for, joins sent and waiting, self-copies (31602)
 * found on relays that prove a join from another device, and recently opened ones.
 */
class Membership(
    private val nostr: Nostr,
    private val cache: Cache,
    private val keys: EventKeysStore,
    private val prefs: AppPrefs,
) {
    @Serializable
    data class Recent(val coordinate: String, val naddr: String, val at: Long)

    private val recentSer = MapSerializer(String.serializer(), Recent.serializer())
    private val joinSer = MapSerializer(String.serializer(), Long.serializer())

    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> get() = _version

    fun role(owner: String?, coordinate: String): Role {
        if (owner == null) return Role.VISITOR
        val k = keys.get(owner, coordinate)
        return when {
            k?.isOrganizer == true -> Role.ORGANIZER
            k?.current != null -> Role.ATTENDEE
            joinSentAt(owner, coordinate) != null -> Role.PENDING
            else -> Role.VISITOR
        }
    }

    // ── join-sent markers (stores/join-sent.svelte.ts), owner-scoped ─────────

    private fun joinKey(owner: String) = "join-sent:$owner"

    fun joinSentAt(owner: String, coordinate: String): Long? =
        prefs.getString(joinKey(owner))?.let { runCatching { cache.json.decodeFromString(joinSer, it) }.getOrNull() }?.get(coordinate)

    fun markJoinSent(owner: String, coordinate: String) {
        val m = (prefs.getString(joinKey(owner))?.let { runCatching { cache.json.decodeFromString(joinSer, it) }.getOrNull() } ?: emptyMap()).toMutableMap()
        m[coordinate] = nowSec()
        prefs.putString(joinKey(owner), cache.json.encodeToString(joinSer, m))
        _version.value++
    }

    fun clearJoinSent(owner: String, coordinate: String) {
        val m = (prefs.getString(joinKey(owner))?.let { runCatching { cache.json.decodeFromString(joinSer, it) }.getOrNull() } ?: emptyMap()).toMutableMap()
        if (m.remove(coordinate) != null) prefs.putString(joinKey(owner), cache.json.encodeToString(joinSer, m))
        _version.value++
    }

    fun joinsSent(owner: String): Map<String, Long> =
        prefs.getString(joinKey(owner))?.let { runCatching { cache.json.decodeFromString(joinSer, it) }.getOrNull() } ?: emptyMap()

    // ── recently opened ──────────────────────────────────────────────────────

    suspend fun noteOpened(scope: String, coordinate: String, naddr: String) {
        val m = (cache.get(scope, "recent-events", recentSer) ?: emptyMap()).toMutableMap()
        m[coordinate] = Recent(coordinate, naddr, nowSec())
        val trimmed = m.values.sortedByDescending { it.at }.take(50).associateBy { it.coordinate }
        cache.put(scope, "recent-events", recentSer, trimmed)
        _version.value++
    }

    suspend fun recent(scope: String): List<Recent> = cache.get(scope, "recent-events", recentSer)?.values?.sortedByDescending { it.at } ?: emptyList()

    suspend fun forget(scope: String, coordinate: String) {
        val m = (cache.get(scope, "recent-events", recentSer) ?: emptyMap()).toMutableMap()
        m.remove(coordinate)
        cache.put(scope, "recent-events", recentSer, m)
        _version.value++
    }

    // ── self-copies on relays (membership.ts discoverJoinedSpaces) ──────────

    /**
     * 31602 self-copies name the events this account joined, from any device.
     * Each decrypt is a signer call, so results are memoized per event id and a
     * remote signer is asked for at most [maxDecrypts] new ones per pass.
     */
    suspend fun discoverJoined(signer: NostrSigner, maxDecrypts: Int = 30): Map<String, Long> {
        val pk = signer.pubkey
        nostr.fetch(Relays.DEFAULT, Filter(kinds = listOf(Kinds.MY_PROFILE), authors = listOf(pk)))
        val events = nostr.store.query(Filter(kinds = listOf(Kinds.MY_PROFILE), authors = listOf(pk)))
        val memo = (cache.get(pk, "joinselfcopies", MapSerializer(String.serializer(), String.serializer())) ?: emptyMap()).toMutableMap()
        var dirty = false
        var budget = maxDecrypts
        val found = HashMap<String, Long>()
        for (e in events.sortedByDescending { it.createdAt }) {
            val remembered = memo[e.id]
            if (remembered != null) { if (remembered.isNotEmpty()) found.merge(remembered, e.createdAt, ::maxOf); continue }
            if (!signer.isLocal && budget-- <= 0) break
            val pt = runCatching { signer.nip44Decrypt(pk, e.content) }.getOrNull() ?: continue
            val a = (jsonObjectOf(pt)?.get("a") as? JsonPrimitive)?.content?.takeIf { Coordinate.isSpace(it) } ?: ""
            memo[e.id] = a
            dirty = true
            if (a.isNotEmpty()) found.merge(a, e.createdAt, ::maxOf)
        }
        if (dirty) cache.put(pk, "joinselfcopies", MapSerializer(String.serializer(), String.serializer()), memo)
        return found
    }

    fun bump() { _version.value++ }
}
