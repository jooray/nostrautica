package today.cypherpunk.nostrautica.domain.dm

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner

/** The stored list exists but its private half is not NIP-44 (a NIP-04 list from an older client). */
class UnreadableMuteList(val legacy: Boolean) : Exception("mute.unreadable")

/** No relay answered and nothing is on the phone: refuse to write a list over one we never saw. */
class MuteListOffline : Exception("error.cat.offline")

/**
 * The NIP-51 mute list (kind 10000) as the DM screens need it — a minimal port of
 * events/mutes.ts + stores/mutes.svelte.ts:
 *
 * - private `p` items are NIP-44 self-encrypted in `content`; public items and
 *   every unknown tag survive a write verbatim (fetch-merge-write, never blind);
 * - a content that is not NIP-44 (legacy NIP-04) is never sent to the signer, and
 *   is a definitive "unreadable" that also blocks writes, so one failed read can
 *   never republish an empty list over the user's real one;
 * - the decrypted set is cached against the 10000's event id, so it is decrypted
 *   once per version, whoever wrote that version (this screen, the attendee page,
 *   another client).
 */
class DmMutes(private val nostr: Nostr, private val cache: Cache, private val accounts: Accounts) {
    @Serializable
    data class Cached(val eventId: String? = null, val muted: List<String> = emptyList(), val unreadable: Boolean = false)

    data class State(val publicTags: List<List<String>>, val privateTags: List<List<String>>) {
        val muted: Set<String> get() = (publicTags + privateTags).filter { it.size >= 2 && it[0] == "p" && it[1].isNotEmpty() }.map { it[1] }.toSet()
    }

    private val lock = Mutex()
    private var owner: String? = null
    private val _muted = MutableStateFlow<Set<String>>(emptySet())
    val muted: StateFlow<Set<String>> get() = _muted
    private val _unreadable = MutableStateFlow(false)
    val unreadable: StateFlow<Boolean> get() = _unreadable

    /** Point at [pubkey] (or nobody), painting its cached set. */
    suspend fun setOwner(pubkey: String?) = lock.withLock {
        if (owner == pubkey) return@withLock
        owner = pubkey
        val c = pubkey?.let { cache.get(it, KEY, Cached.serializer()) }
        _muted.value = c?.muted?.toSet() ?: emptySet()
        _unreadable.value = c?.unreadable ?: false
    }

    /**
     * Bring the set up to date with the newest 10000 on the phone (fetched first
     * when [fetch]). Costs a decrypt only when that event changed. Failures leave
     * the cached set in place — muting is best effort for reading.
     */
    suspend fun refresh(signer: NostrSigner, fetch: Boolean) {
        val me = signer.pubkey
        setOwner(me)
        if (fetch && !cache.isFresh("$KEY:$me", TTL_MS)) {
            val r = nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.MUTE_LIST), authors = listOf(me)))
            if (r.answered > 0) cache.markFetched("$KEY:$me")
        }
        val latest = nostr.store.latest(Kinds.MUTE_LIST, me)
        val cached = cache.get(me, KEY, Cached.serializer())
        if (latest == null) { remember(me, Cached(null, emptyList(), false)); return }
        if (cached?.eventId == latest.id) return
        try {
            remember(me, Cached(latest.id, read(signer, latest).muted.toList(), false))
        } catch (e: UnreadableMuteList) {
            // Definitive: that payload will not become NIP-44 on the next try. Public items still count.
            val publicOnly = State(latest.tags, emptyList()).muted
            remember(me, Cached(latest.id, (publicOnly + (cached?.muted ?: emptyList())).toList(), true))
        }
    }

    private suspend fun remember(me: String, c: Cached) {
        cache.put(me, KEY, Cached.serializer(), c, today.cypherpunk.nostrautica.protocol.nowSec())
        if (owner == me) { _muted.value = c.muted.toSet(); _unreadable.value = c.unreadable }
    }

    /** Decrypt a list's private half. Throws [UnreadableMuteList] without asking the signer when it is not NIP-44. */
    suspend fun read(signer: NostrSigner, e: NostrEvent): State {
        if (e.content.isEmpty()) return State(e.tags, emptyList())
        if (!Nip44.isCiphertext(e.content)) throw UnreadableMuteList(Nip44.isNip04Ciphertext(e.content))
        return State(e.tags, parsePrivate(signer.nip44Decrypt(signer.pubkey, e.content)))
    }

    /** Mute or unmute [peer]: fetch the freshest list, merge, publish. Returns the new muted state. */
    suspend fun toggle(signer: NostrSigner, peer: String): Boolean {
        val me = signer.pubkey
        val r = nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.MUTE_LIST), authors = listOf(me)))
        val latest = nostr.store.latest(Kinds.MUTE_LIST, me)
        if (latest == null && r.answered == 0) throw MuteListOffline()
        val state = latest?.let { read(signer, it) } ?: State(emptyList(), emptyList())
        val willMute = peer !in state.muted
        val next = if (willMute) addPrivate(state, peer) else remove(state, peer)
        val content = if (next.privateTags.isEmpty()) "" else signer.nip44Encrypt(me, encodePrivate(next.privateTags))
        val (ev, _) = accounts.signAndPublish(Kinds.MUTE_LIST, content, next.publicTags, Relays.DEFAULT, "mute")
        remember(me, Cached(ev.id, next.muted.toList(), false))
        return willMute
    }

    companion object {
        const val KEY = "dm-mutes"
        const val TTL_MS = 10 * 60_000L

        fun parsePrivate(json: String): List<List<String>> {
            val arr = runCatching { Json.parseToJsonElement(json) as? JsonArray }.getOrNull() ?: return emptyList()
            return arr.mapNotNull { t -> (t as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } }
        }

        fun encodePrivate(tags: List<List<String>>): String = JsJson.stringify(JsonArray(tags.map { t -> JsonArray(t.map(::JsonPrimitive)) }))

        /** Add as a PRIVATE mute; no-op when already muted publicly or privately. */
        fun addPrivate(s: State, pubkey: String): State =
            if (pubkey in s.muted) s else State(s.publicTags, s.privateTags + listOf(listOf("p", pubkey)))

        /** Remove from both halves, leaving every other tag untouched. */
        fun remove(s: State, pubkey: String): State {
            fun drop(tags: List<List<String>>) = tags.filterNot { it.size >= 2 && it[0] == "p" && it[1] == pubkey }
            return State(drop(s.publicTags), drop(s.privateTags))
        }
    }
}
