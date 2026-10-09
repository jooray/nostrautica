package today.cypherpunk.nostrautica.domain.content

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.AppPrefs
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.EventKeysStore
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.ExternalFeed
import today.cypherpunk.nostrautica.protocol.Kinds
import java.io.File

/** The content area's services, created on first use. */
val AppContainer.content: Content
    get() = area("content") { Content(nostr, cache, eventKeys, members, prefs, MediaFiles(File(context.cacheDir, "talk-media"), http)) }

/**
 * Posts, the event page and talks (events/posts.ts, event-page.ts, talks.ts).
 *
 * Everything is derived from the local event store, so a screen paints from
 * the phone and works offline; the network is asked only when the last fetch
 * for that event is older than [TTL_MS] (or on pull-to-refresh). The derived,
 * decrypted results are cached per owner (members-only content never lands in
 * the anonymous scope), so the UI observes those and repaints when they change.
 */
class Content(
    private val nostr: Nostr,
    private val cache: Cache,
    private val keys: EventKeysStore,
    private val members: Members,
    private val prefs: AppPrefs,
    val media: MediaFiles,
) {
    private val locks = HashMap<String, Mutex>()
    private fun lockFor(k: String) = synchronized(locks) { locks.getOrPut(k) { Mutex() } }

    private val postList = ListSerializer(EventPost.serializer())
    private val talkList = ListSerializer(TalkItem.serializer())
    private val strings = ListSerializer(String.serializer())

    enum class Slot(val key: String) { EVENT("event"), ATTENDEES("attendees"), EXTERNAL("external") }

    fun scope(owner: String?) = owner ?: Cache.ANON
    private fun postsKey(c: String, s: Slot) = "posts:$c:${s.key}"
    private fun pageKey(c: String) = "page:$c"
    private fun talksKey(c: String) = "talks:$c"
    private fun favKey(c: String) = "favtalks:$c"
    private fun watchKey(c: String, x: String) = "talkwatch:$c:$x"

    private fun eck(owner: String?, coordinate: String): List<EckVersion> =
        owner?.let { keys.get(it, coordinate)?.eck } ?: emptyList()

    // ── Observing (UI) ──────────────────────────────────────────────────────

    fun observePosts(owner: String?, coordinate: String, slot: Slot): Flow<List<EventPost>?> =
        cache.observe(scope(owner), postsKey(coordinate, slot), postList)

    fun observePage(owner: String?, coordinate: String): Flow<EventPageModel?> =
        cache.observe(scope(owner), pageKey(coordinate), EventPageModel.serializer())

    fun observeTalks(owner: String, coordinate: String): Flow<List<TalkItem>?> =
        cache.observe(owner, talksKey(coordinate), talkList)

    fun observeRosterCount(owner: String, coordinate: String): Flow<Int?> =
        members.observeRoster(owner, coordinate).map { it?.attendees?.size }

    suspend fun cachedPosts(owner: String?, coordinate: String, slot: Slot): List<EventPost>? =
        cache.get(scope(owner), postsKey(coordinate, slot), postList)

    suspend fun cachedPage(owner: String?, coordinate: String): EventPageModel? =
        cache.get(scope(owner), pageKey(coordinate), EventPageModel.serializer())

    /** One post by `d` from the cached feeds (no network). */
    suspend fun cachedPostByD(owner: String?, coordinate: String, d: String): EventPost? =
        Slot.entries.firstNotNullOfOrNull { s -> cachedPosts(owner, coordinate, s)?.firstOrNull { it.d == d } }

    // ── Event page (31608) ──────────────────────────────────────────────────

    private fun eid(ctx: EventContext) = ctx.coord.pubkey

    private suspend fun rebuildPage(ctx: EventContext, owner: String?): EventPageModel? {
        val events = nostr.local(Filter(kinds = listOf(Kinds.EVENT_PAGE), authors = listOf(eid(ctx)), tags = mapOf("d" to listOf(ctx.coord.identifier))))
        val model = PageLogic.assemble(eid(ctx), events, eck(owner, ctx.coordinate)) ?: return null
        val at = events.maxOfOrNull { it.createdAt } ?: 0
        // Stamped with the 31608's time: an equal stamp still overwrites, so a
        // members-only part that only now decrypts replaces the public-only copy.
        cache.put(scope(owner), pageKey(ctx.coordinate), EventPageModel.serializer(), model, at)
        return model
    }

    // ── Posts ───────────────────────────────────────────────────────────────

    private suspend fun putPosts(owner: String?, coordinate: String, slot: Slot, posts: List<EventPost>) {
        // Stamped with "now": the feed is re-derived from the store each time, so
        // the newest derivation is the truest one (a deletion can make it shorter).
        cache.put(scope(owner), postsKey(coordinate, slot), postList, posts.take(PostLogic.MAX_CACHED_POSTS), System.currentTimeMillis() / 1000)
    }

    private suspend fun rebuildEventPosts(ctx: EventContext, owner: String?): List<EventPost> {
        val eid = eid(ctx)
        val events = nostr.local(Filter(kinds = listOf(Kinds.LONGFORM, Kinds.MEMBERS_POST), authors = listOf(eid)))
        val dels = nostr.local(Filter(kinds = listOf(Kinds.DELETION), authors = listOf(eid)))
        return PostLogic.eventPosts(eid, events, dels, eck(owner, ctx.coordinate)).also { putPosts(owner, ctx.coordinate, Slot.EVENT, it) }
    }

    private suspend fun rebuildAttendeePosts(ctx: EventContext, owner: String?): List<EventPost> {
        val events = nostr.local(Filter(kinds = listOf(Kinds.LONGFORM), tags = mapOf("a" to listOf(ctx.coordinate))))
        val roster = owner?.let { members.cachedRoster(it, ctx.coordinate) }?.takeIf { it.attendees.isNotEmpty() }
        val authors = events.map { it.pubkey }.distinct()
        val dels = if (authors.isEmpty()) emptyList() else nostr.local(Filter(kinds = listOf(Kinds.DELETION), authors = authors))
        return PostLogic.attendeePosts(eid(ctx), ctx.coordinate, events, roster?.attendees?.map { it.pubkey }?.toSet(), dels)
            .also { putPosts(owner, ctx.coordinate, Slot.ATTENDEES, it) }
    }

    private suspend fun rebuildExternalPosts(ctx: EventContext, owner: String?, sources: List<ExternalFeed>): List<EventPost> {
        val feeds = sources.filter { it.pubkey != eid(ctx) }
        if (feeds.isEmpty()) {
            // Delete, not an empty write: removing the last feed must remove its articles.
            cache.delete(scope(owner), postsKey(ctx.coordinate, Slot.EXTERNAL))
            return emptyList()
        }
        val events = nostr.local(Filter(kinds = listOf(Kinds.LONGFORM), authors = feeds.map { it.pubkey }.distinct()))
        return PostLogic.externalPosts(eid(ctx), feeds, events).also { putPosts(owner, ctx.coordinate, Slot.EXTERNAL, it) }
    }

    /** Re-derive everything from the phone (also after an ECK arrives): no network. */
    suspend fun rebuild(ctx: EventContext, owner: String?, attendees: Boolean = true) = lockFor(ctx.coordinate).withLock {
        val page = rebuildPage(ctx, owner)
        rebuildEventPosts(ctx, owner)
        rebuildExternalPosts(ctx, owner, page?.sources ?: emptyList())
        if (attendees || PageLogic.needsAttendeePosts(page)) rebuildAttendeePosts(ctx, owner)
    }

    /**
     * Fetch the event's page, official posts, deletions and (when wanted) the
     * attendee feed in one round, then the curated feeds the page declares,
     * one subscription per distinct relay set. Skipped when fresh.
     */
    suspend fun refresh(ctx: EventContext, owner: String?, force: Boolean = false, attendees: Boolean = true) {
        val base = "content:posts:${ctx.coordinate}"
        val fk = base + if (attendees) ":a" else ""
        // A fresh fetch that included the attendee feed also covers one that doesn't.
        val fresh = cache.isFresh(fk, TTL_MS) || (!attendees && cache.isFresh("$base:a", TTL_MS))
        if (!force && fresh) { rebuild(ctx, owner, attendees); return }
        val eid = eid(ctx)
        val filters = mutableListOf(
            Filter(kinds = listOf(Kinds.LONGFORM, Kinds.MEMBERS_POST), authors = listOf(eid)),
            Filter(kinds = listOf(Kinds.EVENT_PAGE), authors = listOf(eid), tags = mapOf("d" to listOf(ctx.coord.identifier))),
            Filter(kinds = listOf(Kinds.DELETION), authors = listOf(eid), tags = mapOf("k" to listOf("${Kinds.LONGFORM}", "${Kinds.MEMBERS_POST}"))),
        )
        if (attendees) filters += Filter(kinds = listOf(Kinds.LONGFORM), tags = mapOf("a" to listOf(ctx.coordinate)))
        val r = nostr.fetch(ctx.relays, *filters.toTypedArray())
        val page = lockFor(ctx.coordinate).withLock { rebuildPage(ctx, owner) }
        var allAnswered = r.answered > 0
        if (!attendees && PageLogic.needsAttendeePosts(page)) {
            nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.LONGFORM), tags = mapOf("a" to listOf(ctx.coordinate))))
        }
        val feeds = page?.sources?.filter { it.pubkey != eid } ?: emptyList()
        if (feeds.isNotEmpty()) {
            val groups = feeds.groupBy { f -> (f.relays?.takeIf { it.isNotEmpty() } ?: ctx.relays).map(RelayPool::normalize).sorted() }
            val results = coroutineScope {
                groups.map { (relays, group) -> async { runCatching { nostr.fetch(relays, *group.map(PostLogic::externalFeedFilter).toTypedArray()) }.getOrNull() } }.awaitAll()
            }
            allAnswered = allAnswered && results.all { it != null && it.answered > 0 }
        }
        rebuild(ctx, owner, attendees)
        if (allAnswered) cache.markFetched(fk)
    }

    /** One post by `d` (posts.ts fetchPostByD), from the store after a fetch when stale. */
    suspend fun postByD(ctx: EventContext, owner: String?, d: String, force: Boolean = false): EventPost? {
        val eid = eid(ctx)
        val sources = cachedPage(owner, ctx.coordinate)?.sources ?: emptyList()
        val authors = (listOf(eid) + sources.map { it.pubkey }).distinct()
        val fk = "content:post:${ctx.coordinate}:$d"
        if (force || !cache.isFresh(fk, TTL_MS)) {
            val relays = (ctx.relays + sources.flatMap { it.relays ?: emptyList() }).map(RelayPool::normalize).distinct()
            val r = nostr.fetch(
                relays,
                Filter(kinds = listOf(Kinds.LONGFORM, Kinds.MEMBERS_POST), authors = authors, tags = mapOf("d" to listOf(d))),
                Filter(kinds = listOf(Kinds.EVENT_PAGE), authors = listOf(eid), tags = mapOf("d" to listOf(ctx.coord.identifier))),
            )
            lockFor(ctx.coordinate).withLock { rebuildPage(ctx, owner) }
            if (r.answered > 0) cache.markFetched(fk)
        }
        val fresh = cachedPage(owner, ctx.coordinate)?.sources ?: sources
        val events = nostr.local(Filter(kinds = listOf(Kinds.LONGFORM, Kinds.MEMBERS_POST), authors = (listOf(eid) + fresh.map { it.pubkey }).distinct(), tags = mapOf("d" to listOf(d))))
        val dels = nostr.local(Filter(kinds = listOf(Kinds.DELETION), authors = events.map { it.pubkey }.distinct().ifEmpty { listOf(eid) }))
        return PostLogic.postByD(eid, d, fresh, events, dels, eck(owner, ctx.coordinate))
    }

    // ── Talks (31610) ───────────────────────────────────────────────────────

    data class TalksState(val items: List<TalkItem>, val newerSeen: Boolean)

    private suspend fun rebuildTalks(ctx: EventContext, owner: String): TalksState? {
        val eck = eck(owner, ctx.coordinate)
        // No key yet (still recovering on a fresh device): keep what was last shown.
        if (eck.isEmpty()) return null
        val authors = members.acceptedAuthors(ctx)
        val events = nostr.local(Filter(kinds = listOf(Kinds.TALK), authors = authors, tags = mapOf("a" to listOf(ctx.coordinate))))
        val dels = nostr.local(Filter(kinds = listOf(Kinds.DELETION), authors = authors, tags = mapOf("k" to listOf("${Kinds.TALK}"))))
        val decoded = TalkLogic.decode(ctx.coordinate, authors, events, dels, eck)
        val prior = cache.get(owner, talksKey(ctx.coordinate), talkList)
        val merged = TalkLogic.merge(prior, decoded)
        cache.put(owner, talksKey(ctx.coordinate), talkList, merged, System.currentTimeMillis() / 1000)
        return TalksState(merged, decoded.newerSeen)
    }

    /**
     * Fetch (when stale) and decrypt the event's talks. Null when the viewer
     * holds no ECK (the cached set, if any, keeps painting).
     */
    suspend fun refreshTalks(ctx: EventContext, owner: String, force: Boolean = false): TalksState? {
        if (ctx.cfg.talks == "off") return TalksState(emptyList(), false)
        val fk = "content:talks:${ctx.coordinate}"
        if (force || !cache.isFresh(fk, TTL_MS)) {
            val authors = members.acceptedAuthors(ctx)
            val r = nostr.fetch(
                ctx.relays,
                Filter(kinds = listOf(Kinds.TALK), authors = authors, tags = mapOf("a" to listOf(ctx.coordinate))),
                Filter(kinds = listOf(Kinds.DELETION), authors = authors, tags = mapOf("k" to listOf("${Kinds.TALK}"))),
            )
            if (r.answered == 0 && nostr.network.value) throw java.io.IOException("no relay answered")
            if (r.answered > 0) cache.markFetched(fk)
        }
        return lockFor("talks:${ctx.coordinate}").withLock { rebuildTalks(ctx, owner) }
    }

    suspend fun cachedTalk(owner: String, coordinate: String, d: String): TalkItem? =
        cache.get(owner, talksKey(coordinate), talkList)?.firstOrNull { it.d == d }

    // ── Favorites (local, per event; post-event report reads them) ─────────

    fun observeFavorites(owner: String, coordinate: String): Flow<List<String>> =
        cache.observe(owner, favKey(coordinate), strings).map { it ?: emptyList() }

    suspend fun favorites(owner: String, coordinate: String): List<String> = cache.get(owner, favKey(coordinate), strings) ?: emptyList()

    suspend fun toggleFavorite(owner: String, coordinate: String, d: String): List<String> {
        val cur = favorites(owner, coordinate)
        val next = if (d in cur) cur - d else cur + d
        cache.put(owner, favKey(coordinate), strings, next)
        return next
    }

    /** Favorited talks as (d, title), dropping ones no longer known (talks.ts favoriteTalkItems). */
    suspend fun favoriteTalkItems(owner: String, coordinate: String): List<Pair<String, String>> {
        val byD = (cache.get(owner, talksKey(coordinate), talkList) ?: emptyList()).associate { it.d to it.talk.title }
        return favorites(owner, coordinate).mapNotNull { d -> byD[d]?.let { d to it } }
    }

    // ── Watch progress (device-local, keyed by the ciphertext hash) ────────

    suspend fun watchProgress(owner: String, coordinate: String, x: String): Long =
        cache.get(owner, watchKey(coordinate, x), Long.serializer()) ?: 0L

    /**
     * Fire-and-forget on the service's own scope: the last report comes from a
     * player being disposed, after the screen's own scope is already cancelled.
     */
    fun saveWatchProgress(owner: String, coordinate: String, x: String, seconds: Long) {
        io.launch { cache.put(owner, watchKey(coordinate, x), Long.serializer(), seconds) }
    }

    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // ── Playback speed (persists across players, as the PWA's localStorage) ─

    fun playbackRate(): Float = prefs.getString(RATE_KEY)?.toFloatOrNull()?.takeIf { it in SPEEDS } ?: 1f
    fun setPlaybackRate(r: Float) = prefs.putString(RATE_KEY, r.toString())

    companion object {
        const val TTL_MS = 5 * 60_000L
        val SPEEDS = listOf(1f, 1.5f, 2f)
        private const val RATE_KEY = "playbackRate"
    }
}
