package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.MatchListContent
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Roster
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Wire

/** The newest roster/directory couldn't be read because this build is too old. */
class NewerProtocolSeen : Exception("update required")

/**
 * The member-only data of an event (events/attendee.ts): the roster (31604, paged),
 * the directory (31603, one entry per blinded `d`) and this user's matches
 * (31605, NIP-44 from the coordinator). Each is decrypted once, cached per owner,
 * and refreshed only when stale, so People and Matches open instantly and offline.
 *
 * Record authority (NIP §3.7): only records authored by the event's CURRENT
 * coordinator, or by E_id, are accepted.
 */
class Members(
    private val nostr: Nostr,
    private val cache: Cache,
    private val keys: EventKeysStore,
) {
    private val locks = HashMap<String, Mutex>()
    private fun lockFor(k: String) = synchronized(locks) { locks.getOrPut(k) { Mutex() } }

    fun acceptedAuthors(ctx: EventContext): List<String> {
        val c = ctx.cfg
        return listOfNotNull(c.coordinator, c.eidPubkey)
    }

    fun eckFor(owner: String, coordinate: String, versionTag: String? = null): ByteArray? {
        val k = keys.get(owner, coordinate) ?: return null
        return k.eckFor(versionTag?.toIntOrNull()) ?: k.current?.bytes()
    }

    private fun rosterKey(c: String) = "roster:$c"
    private fun dirKey(c: String) = "dir:$c"
    private fun matchesKey(c: String) = "matches:$c"

    fun observeRoster(owner: String, coordinate: String): Flow<RosterContent?> =
        cache.observe(owner, rosterKey(coordinate), RosterContent.serializer())

    fun observeDirectory(owner: String, coordinate: String): Flow<List<DirectoryEntryContent>> =
        cache.observe(owner, dirKey(coordinate), ListSerializer(DirectoryEntryContent.serializer())).map { it ?: emptyList() }

    fun observeMatches(owner: String, coordinate: String): Flow<MatchListContent?> =
        cache.observe(owner, matchesKey(coordinate), MatchListContent.serializer())

    suspend fun cachedRoster(owner: String, coordinate: String) = cache.get(owner, rosterKey(coordinate), RosterContent.serializer())
    suspend fun cachedDirectory(owner: String, coordinate: String) =
        cache.get(owner, dirKey(coordinate), ListSerializer(DirectoryEntryContent.serializer())) ?: emptyList()
    suspend fun cachedMatches(owner: String, coordinate: String) = cache.get(owner, matchesKey(coordinate), MatchListContent.serializer())

    /** Refresh roster → directory (and matches) if stale. Safe to call on every screen open. */
    suspend fun refresh(ctx: EventContext, signer: NostrSigner, force: Boolean = false): Boolean = lockFor(ctx.coordinate).withLock {
        val owner = signer.pubkey
        if (keys.get(owner, ctx.coordinate)?.current == null) return@withLock false
        val fresh = !force && cache.isFresh("members:$owner:${ctx.coordinate}", TTL_MS)
        if (fresh) return@withLock true
        val roster = fetchRoster(ctx, owner) ?: return@withLock false
        fetchDirectory(ctx, owner, roster)
        if (ctx.cfg.coordinator != null && ctx.cfg.matching) runCatching { fetchMatches(ctx, signer) }
        cache.markFetched("members:$owner:${ctx.coordinate}")
        true
    }

    private fun decryptRoster(eck: ByteArray, e: NostrEvent): RosterContent? =
        when (val r = runCatching { Nip44.eckDecrypt(eck, e.content) }.getOrNull()?.let { Wire.parseSafe(RosterContent.serializer(), it) }) {
            is Wire.Result.Ok -> r.value
            is Wire.Result.Newer -> throw NewerProtocolSeen()
            else -> null
        }

    suspend fun fetchRoster(ctx: EventContext, owner: String): RosterContent? {
        val c = ctx.coord
        val authors = acceptedAuthors(ctx)
        nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.ROSTER), authors = authors, tags = mapOf("d" to listOf(c.identifier))))
        val latest = authors.mapNotNull { nostr.store.latest(Kinds.ROSTER, it, c.identifier) }.let(Ordering::pickLatest)
            ?: return RosterContent(2, 1, null, null, emptyList()).also { cache.put(owner, rosterKey(ctx.coordinate), RosterContent.serializer(), it, 0) }
        val eck = eckFor(owner, ctx.coordinate, latest.tag("eck")) ?: return null
        val page0 = decryptRoster(eck, latest) ?: return null
        val pages = Roster.pageCountOf(page0)
        var roster = page0
        if (pages > 1) {
            val ds = Roster.continuationDs(c.identifier, pages)
            nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.ROSTER), authors = listOf(latest.pubkey), tags = mapOf("d" to ds)))
            val rest = ds.map { d ->
                val e = nostr.store.latest(Kinds.ROSTER, latest.pubkey, d)?.takeIf { ev -> ev.tag("a") == ctx.coordinate } ?: return null
                decryptRoster(eckFor(owner, ctx.coordinate, e.tag("eck")) ?: return null, e) ?: return null
            }
            roster = Roster.merge(listOf(page0) + rest)
        }
        cache.put(owner, rosterKey(ctx.coordinate), RosterContent.serializer(), roster, latest.createdAt)
        return roster
    }

    suspend fun fetchDirectory(ctx: EventContext, owner: String, roster: RosterContent): List<DirectoryEntryContent> {
        if (roster.attendees.isEmpty()) {
            cache.put(owner, dirKey(ctx.coordinate), ListSerializer(DirectoryEntryContent.serializer()), emptyList())
            return emptyList()
        }
        val authors = acceptedAuthors(ctx)
        val ds = roster.attendees.map { it.d }
        // Chunked #d filters: relays cap filter size, and a long list silently returns fewer people.
        ds.chunked(D_CHUNK).forEach { chunk ->
            nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.DIRECTORY_ENTRY), authors = authors, tags = mapOf("d" to chunk)))
        }
        val events = nostr.store.query(Filter(kinds = listOf(Kinds.DIRECTORY_ENTRY), authors = authors, tags = mapOf("d" to ds)))
        val latestByD = events.groupBy { it.d }.mapNotNull { (_, v) -> Ordering.pickLatest(v) }
        var newest = 0L
        val byPk = LinkedHashMap<String, Pair<DirectoryEntryContent, NostrEvent>>()
        for (e in latestByD) {
            val eck = eckFor(owner, ctx.coordinate, e.tag("eck")) ?: continue
            val entry = (runCatching { Nip44.eckDecrypt(eck, e.content) }.getOrNull()
                ?.let { Wire.parseSafe(DirectoryEntryContent.serializer(), it) } as? Wire.Result.Ok)?.value ?: continue
            val prev = byPk[entry.pubkey]
            if (prev == null || Ordering.supersedes(e, prev.second)) byPk[entry.pubkey] = entry to e
            newest = maxOf(newest, e.createdAt)
        }
        val entries = byPk.values.map { it.first }
        cache.put(owner, dirKey(ctx.coordinate), ListSerializer(DirectoryEntryContent.serializer()), entries, newest)
        return entries
    }

    suspend fun fetchMatches(ctx: EventContext, signer: NostrSigner): MatchListContent? {
        val coordinator = ctx.cfg.coordinator ?: return null
        val owner = signer.pubkey
        val eck = keys.get(owner, ctx.coordinate)?.current?.bytes() ?: return null
        val d = ProtocolCrypto.blindedD(eck, ctx.coordinate, owner)
        nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.MATCH_LIST), authors = listOf(coordinator), tags = mapOf("d" to listOf(d))))
        val latest = nostr.store.latest(Kinds.MATCH_LIST, coordinator, d) ?: return null
        val cached = cache.getRaw(owner, matchesKey(ctx.coordinate))
        if (cached != null && cached.at >= latest.createdAt) return cachedMatches(owner, ctx.coordinate)
        val json = signer.nip44Decrypt(coordinator, latest.content)
        val list = (Wire.parseSafe(MatchListContent.serializer(), json) as? Wire.Result.Ok)?.value ?: return null
        cache.put(owner, matchesKey(ctx.coordinate), MatchListContent.serializer(), list, latest.createdAt)
        return list
    }

    companion object {
        const val TTL_MS = 2 * 60_000L
        const val D_CHUNK = 50
    }
}
