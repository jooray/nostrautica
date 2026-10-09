package today.cypherpunk.nostrautica.domain.people

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.FollowListGuard
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Wire

// Services of the People area, registered lazily on the container. The keys are
// namespaced so another area's registration can never collide with these.

val AppContainer.eventSettings: EventSettingsStore get() = area("people.settings") { EventSettingsStore(nostr, cache, accounts) }
val AppContainer.whatsNew: WhatsNew get() = area("people.whatsNew") { WhatsNew(cache, members) }
val AppContainer.peopleSocial: PeopleSocial get() = area("people.social") { PeopleSocial(nostr, cache, accounts) }

/**
 * User-private per-event settings (events/settings.ts, spec §7.3): favorites,
 * want-to-meet, met and notes in a NIP-44 self-encrypted kind 30078 at
 * `d = nostrautica:ev:<blindedD(blindKey, coordinate, ownPk)>`.
 *
 * - Decrypted once per event id and cached owner-scoped, so a remote signer is
 *   asked again only when the record actually changed.
 * - [load] THROWS when a record exists but can't be read: writes are
 *   read-modify-write, and answering "unreadable" with "empty" would republish an
 *   empty payload over every note the user has.
 */
class EventSettingsStore(private val nostr: Nostr, private val cache: Cache, private val accounts: Accounts) {
    @Serializable
    data class Cached(val id: String, val settings: PerEventSettings)

    private val lock = Mutex()
    private fun key(coordinate: String) = "evsettings:$coordinate"

    fun observe(owner: String, coordinate: String): Flow<PerEventSettings?> =
        cache.observe(owner, key(coordinate), Cached.serializer()).map { it?.settings }

    suspend fun cached(owner: String, coordinate: String): PerEventSettings? =
        cache.get(owner, key(coordinate), Cached.serializer())?.settings

    private suspend fun d(coordinate: String): String =
        "nostrautica:ev:" + ProtocolCrypto.blindedD(accounts.blindingKey(), coordinate, accounts.pubkey)

    /**
     * The current settings: from relays when [network] (and the copy is stale or
     * [force]), else from the phone. Empty when none were ever saved.
     */
    suspend fun load(ctx: EventContext, network: Boolean = true, force: Boolean = false): PerEventSettings {
        val signer = accounts.signer
        val pk = signer.pubkey
        val d = d(ctx.coordinate)
        val freshKey = "evsettings:$pk:${ctx.coordinate}"
        if (network && (force || !cache.isFresh(freshKey, TTL_MS))) {
            val r = nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(pk), tags = mapOf("d" to listOf(d))))
            if (r.answered > 0) cache.markFetched(freshKey)
        }
        // The store only keeps events by their own author for this (kind, pubkey, d),
        // so a foreign 30078 can't wedge the latest-pick.
        val latest = nostr.store.latest(Kinds.APP_DATA, pk, d) ?: return PerEventSettings()
        val c = cache.get(pk, key(ctx.coordinate), Cached.serializer())
        if (c?.id == latest.id) return c.settings
        val json = signer.nip44Decrypt(pk, latest.content)
        val s = Wire.parse(PerEventSettings.serializer(), json)
        cache.put(pk, key(ctx.coordinate), Cached.serializer(), Cached(latest.id, s), latest.createdAt)
        return s
    }

    private suspend fun save(ctx: EventContext, s: PerEventSettings): Nostr.PublishResult {
        val signer = accounts.signer
        val pk = signer.pubkey
        val d = d(ctx.coordinate)
        val content = signer.nip44Encrypt(pk, Wire.encode(PerEventSettings.serializer(), s))
        val (ev, result) = accounts.signAndPublish(Kinds.APP_DATA, content, listOf(listOf("d", d)), Relays.DEFAULT, "settings")
        cache.put(pk, key(ctx.coordinate), Cached.serializer(), Cached(ev.id, s), ev.createdAt)
        return result
    }

    /** Read fresh, change, write: never over a copy that failed to read. */
    suspend fun update(ctx: EventContext, change: (PerEventSettings) -> PerEventSettings): Pair<PerEventSettings, Nostr.PublishResult> = lock.withLock {
        val next = change(load(ctx, network = true, force = true))
        next to save(ctx, next)
    }

    suspend fun toggle(ctx: EventContext, list: SettingList, pubkey: String) = update(ctx) { SettingsRules.toggled(it, list, pubkey) }

    suspend fun setNote(ctx: EventContext, pubkey: String, note: String) = update(ctx) { SettingsRules.withNote(it, pubkey, note) }

    companion object {
        const val TTL_MS = 5 * 60_000L
    }
}

/**
 * "What's new" (stores/whats-new.svelte.ts): who arrived and which matches
 * appeared since the People list was last open. The People tab's badge is a pure
 * read of the cached roster, matches and the watermark, so it never costs a fetch.
 */
class WhatsNew(private val cache: Cache, private val members: Members) {
    private fun key(coordinate: String) = "whatsnew:$coordinate"

    fun observe(owner: String, coordinate: String): Flow<Watermark> =
        cache.observe(owner, key(coordinate), Watermark.serializer()).map { it ?: Watermark() }

    suspend fun load(owner: String, coordinate: String): Watermark =
        cache.get(owner, key(coordinate), Watermark.serializer()) ?: Watermark()

    private suspend fun save(owner: String, coordinate: String, w: Watermark) =
        cache.put(owner, key(coordinate), Watermark.serializer(), w, w.at)

    /** The People tab badge: new matches and new arrivals, deduped. */
    fun peopleBadge(owner: String, coordinate: String): Flow<Int> = combine(
        members.observeMatches(owner, coordinate),
        members.observeDirectory(owner, coordinate),
        observe(owner, coordinate),
    ) { m, dir, wm -> WhatsNewRules.newSince(m?.matches?.map { it.pubkey }, dir.map { it.pubkey }, wm).size }

    /** No-op when nothing moved, so the badge isn't recomputed for nothing. */
    suspend fun markMatchesSeen(owner: String, coordinate: String, matchPubkeys: List<String>) {
        val wm = load(owner, coordinate)
        if (wm.seenMatches == matchPubkeys) return
        save(owner, coordinate, wm.copy(seenMatches = matchPubkeys, at = nowSec()))
    }

    /** The baseline the NEXT visit compares against. */
    suspend fun markRosterSeen(owner: String, coordinate: String, pubkeys: List<String>) {
        val wm = load(owner, coordinate)
        val next = pubkeys.distinct().sorted()
        if (wm.seenPeople == next) return
        save(owner, coordinate, wm.copy(seenPeople = next, at = nowSec()))
    }

    suspend fun approvalIsNew(owner: String, coordinate: String, approved: Boolean) =
        WhatsNewRules.approvalIsNew(approved, load(owner, coordinate))

    suspend fun markApprovedSeen(owner: String, coordinate: String) {
        val wm = load(owner, coordinate)
        if (wm.seenApproved) return
        save(owner, coordinate, wm.copy(seenApproved = true, at = nowSec()))
    }

    private fun nowSec() = System.currentTimeMillis() / 1000
}

/**
 * The public social bits People and a person's page need: the user's follow set
 * (kind 3), "follows you", someone's recent notes. Store-first, refreshed on TTLs
 * so reopening a profile costs nothing on the network.
 */
class PeopleSocial(private val nostr: Nostr, private val cache: Cache, private val accounts: Accounts) {
    private fun contacts(pk: String) = Filter(kinds = listOf(Kinds.CONTACTS), authors = listOf(pk))

    /** The user's current kind 3 on the phone (null = never seen one). */
    fun observeFollowList(me: String): Flow<NostrEvent?> = nostr.observe(contacts(me)).map { l -> l.maxByOrNull { it.createdAt } }

    /**
     * Refresh the follow list if stale, bounded at 8 s (audit UX-10: an unbounded
     * fetch left the button at "…" forever). True when the set is now known.
     */
    suspend fun refreshFollows(me: String, force: Boolean = false): Boolean {
        val k = "k3:$me"
        if (!force && cache.isFresh(k, FOLLOWS_TTL_MS)) return true
        val r = withTimeoutOrNull(8_000) { nostr.fetch(Relays.READ, contacts(me)) }
        if (r != null && r.answered > 0) { cache.markFetched(k); return true }
        return nostr.store.latest(Kinds.CONTACTS, me) != null
    }

    /**
     * Follow or unfollow, merged into the freshest list (nostr-actions.ts). Throws
     * [FollowListGuard] when no list could be read: publishing onto an unfetched
     * list would wipe the user's whole social graph.
     */
    suspend fun setFollowing(target: String, follow: Boolean): Nostr.PublishResult? {
        require(target.length == 64) { "bad pubkey" }
        val me = accounts.pubkey
        nostr.fetch(Relays.READ, contacts(me))
        val existing = nostr.store.latest(Kinds.CONTACTS, me) ?: throw FollowListGuard()
        val has = existing.tags.any { it.size >= 2 && it[0] == "p" && it[1] == target }
        val tags = when {
            follow && has -> return null
            follow -> existing.tags + listOf(listOf("p", target))
            !has -> return null
            else -> existing.tags.filterNot { it.size >= 2 && it[0] == "p" && it[1] == target }
        }
        return accounts.signAndPublish(Kinds.CONTACTS, existing.content, tags, Relays.DEFAULT, if (follow) "follow" else "unfollow").second
    }

    /** Whether [them]'s latest kind 3 p-tags [me]. Phone first, relays every 30 min. */
    suspend fun followsYou(me: String, them: String): Boolean {
        val k = "followsyou:$them"
        if (!cache.isFresh(k, FOLLOWERS_TTL_MS)) {
            val r = nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.CONTACTS), authors = listOf(them), tags = mapOf("p" to listOf(me))))
            if (r.answered > 0) cache.markFetched(k)
        }
        return nostr.store.latest(Kinds.CONTACTS, them)?.tags?.any { it.size >= 2 && it[0] == "p" && it[1] == me } == true
    }

    private fun notes(pk: String, limit: Int) = Filter(kinds = listOf(Kinds.NOTE), authors = listOf(pk), limit = limit)

    fun observeRecentPosts(pk: String, limit: Int = 20): Flow<List<NostrEvent>> = nostr.observe(notes(pk, limit))

    suspend fun refreshRecentPosts(pk: String, limit: Int = 20) {
        val k = "notes:$pk"
        if (cache.isFresh(k, POSTS_TTL_MS)) return
        val r = nostr.fetch(Relays.READ, notes(pk, limit))
        if (r.answered > 0) cache.markFetched(k)
    }

    /** When this device last believed a roster read (the stale cue's clock), ms. */
    suspend fun rosterReadAt(owner: String, coordinate: String): Long? = cache.get(owner, "roster-read:$coordinate", Long.serializer())

    suspend fun markRosterRead(owner: String, coordinate: String, atMs: Long) =
        cache.put(owner, "roster-read:$coordinate", Long.serializer(), atMs, atMs / 1000)

    companion object {
        const val FOLLOWS_TTL_MS = 10 * 60_000L
        const val FOLLOWERS_TTL_MS = 30 * 60_000L
        const val POSTS_TTL_MS = 15 * 60_000L
    }
}

/** Count directory entries that exist on the phone but won't open under this device's ECK (EV-9). */
suspend fun Members.undecryptableEntries(nostr: Nostr, ctx: EventContext, owner: String): Int {
    val roster = cachedRoster(owner, ctx.coordinate) ?: return 0
    if (roster.attendees.isEmpty()) return 0
    // Chunked: older Android SQLite caps a statement at 999 bound variables.
    val events = roster.attendees.map { it.d }.chunked(SQL_CHUNK).flatMap { ds ->
        nostr.store.query(Filter(kinds = listOf(Kinds.DIRECTORY_ENTRY), authors = acceptedAuthors(ctx), tags = mapOf("d" to ds)))
    }
    return events.count { e ->
        val eck = eckFor(owner, ctx.coordinate, e.tag("eck")) ?: return@count true
        runCatching { Nip44.eckDecrypt(eck, e.content) }.isFailure
    }
}

/** Bound variables per local query: older Android SQLite allows at most 999. */
const val SQL_CHUNK = 400

/** Profiles for any number of people, observed in chunks the local store can bind. */
fun today.cypherpunk.nostrautica.domain.Profiles.observeMany(pubkeys: List<String>): Flow<Map<String, today.cypherpunk.nostrautica.domain.ProfileMeta>> {
    if (pubkeys.size <= SQL_CHUNK) return observe(pubkeys)
    val parts = pubkeys.distinct().chunked(SQL_CHUNK).map { observe(it) }
    return combine(parts) { maps -> maps.fold(emptyMap()) { acc, m -> acc + m } }
}
