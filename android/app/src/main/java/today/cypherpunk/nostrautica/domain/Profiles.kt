package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.jsonObjectOf

/** A kind-0 profile, as the UI reads it (events/social.ts ProfileMeta). */
data class ProfileMeta(
    val pubkey: String,
    val name: String? = null,
    val picture: String? = null,
    val banner: String? = null,
    val about: String? = null,
    val nip05: String? = null,
    val website: String? = null,
    val lud16: String? = null,
    val raw: JsonObject = JsonObject(emptyMap()),
) {
    companion object {
        /** social.ts profileDisplayName: display_name, displayName, then name. */
        fun displayName(o: JsonObject): String? =
            listOf("display_name", "displayName", "name").firstNotNullOfOrNull { (o[it] as? JsonPrimitive)?.content?.trim()?.takeIf { s -> s.isNotEmpty() } }

        fun from(e: NostrEvent): ProfileMeta {
            val o = jsonObjectOf(e.content) ?: JsonObject(emptyMap())
            fun s(k: String) = (o[k] as? JsonPrimitive)?.content?.trim()?.takeIf { it.isNotEmpty() }
            return ProfileMeta(e.pubkey, displayName(o), s("picture")?.takeIf { it.startsWith("https://") }, s("banner"), s("about"), s("nip05"), s("website"), s("lud16"), o)
        }
    }
}

/**
 * Public profiles (kind 0) for the people on a screen. Batched, cache-first, and
 * refreshed at most every [TTL_MS] per person — profile pictures and names change
 * rarely, and a 300-person directory must not refetch on every open.
 */
class Profiles(private val nostr: Nostr, private val cache: Cache) {
    fun observe(pubkeys: Collection<String>): Flow<Map<String, ProfileMeta>> {
        if (pubkeys.isEmpty()) return kotlinx.coroutines.flow.flowOf(emptyMap())
        return nostr.observe(Filter(kinds = listOf(Kinds.PROFILE), authors = pubkeys.toList())).map { events ->
            events.groupBy { it.pubkey }.mapValues { (_, v) -> ProfileMeta.from(v.maxBy { it.createdAt }) }
        }
    }

    suspend fun local(pubkey: String): ProfileMeta? = nostr.store.latest(Kinds.PROFILE, pubkey)?.let(ProfileMeta::from)

    suspend fun refresh(pubkeys: Collection<String>, relays: List<String> = Relays.READ, force: Boolean = false) {
        val due = pubkeys.distinct().filter { force || !cache.isFresh("k0:$it", TTL_MS) }
        if (due.isEmpty()) return
        due.chunked(100).forEach { chunk ->
            nostr.fetch(relays, Filter(kinds = listOf(Kinds.PROFILE), authors = chunk))
            chunk.forEach { cache.markFetched("k0:$it") }
        }
    }

    companion object {
        const val TTL_MS = 6 * 3600_000L
    }
}
