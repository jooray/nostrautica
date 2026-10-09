package today.cypherpunk.nostrautica.domain.content

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.ExternalFeed
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.MembersPostContent
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.Wire

/** Where a post in the event's feed came from (events/posts.ts PostSource). */
enum class PostSource { EVENT, ATTENDEES, EXTERNAL }

/**
 * One post in an event feed (events/posts.ts EventPost): a public 30023 or a
 * members-only 31607 decrypted with the ECK version its `eck` tag names. A 31607
 * the reader holds no key for comes back [locked] with no title or body.
 */
@Serializable
data class EventPost(
    val d: String,
    val kind: Int,
    val membersOnly: Boolean,
    val locked: Boolean,
    val title: String,
    val summary: String? = null,
    val image: String? = null,
    val content: String,
    val publishedAt: Long,
    val editedAt: Long,
    val source: PostSource,
    val authorPubkey: String,
    val author: String? = null,
    val eckVersion: Int? = null,
    val feedLabel: String? = null,
    /** The 31607 was written by a newer protocol than this build reads. */
    val newer: Boolean = false,
) {
    /** A post's identity on a page (EventHome postKey). */
    val key: String get() = "${source.name}:$authorPubkey:$d"
}

/** The feed filters of the Posts page and of a 31608 `posts` section. */
enum class FeedSource { BOTH, EVENT, ATTENDEES }
enum class FeedVisibility { BOTH, PUBLIC, MEMBERS }

/** Pure feed logic, ported from events/posts.ts so it can be unit-tested. */
object PostLogic {
    /** Per declared external feed: the newest this many, never "everything this npub ever wrote". */
    const val MAX_EXTERNAL_PER_FEED = 100

    /** Bound on what the feed cache holds per coordinate (posts.ts MAX_CACHED_POSTS). */
    const val MAX_CACHED_POSTS = 300

    /**
     * `published_at` is author-controlled; a future date would pin an article to
     * the top forever, so it is read as "no usable time" and the post sorts by
     * when it was received.
     */
    fun clampPublishedAt(claimed: Long?, receivedAt: Long, now: Long = System.currentTimeMillis() / 1000): Long =
        minOf(claimed?.takeIf { it > 0 } ?: receivedAt, now)

    /** Keep the newest revision per author+`d` ACROSS BOTH kinds (30023 and 31607). */
    fun dedupeByD(events: List<NostrEvent>): List<NostrEvent> {
        val byKey = LinkedHashMap<String, NostrEvent>()
        for (e in events) {
            val k = "${e.pubkey}:${e.d ?: ""}"
            val seen = byKey[k]
            if (seen == null || Ordering.supersedes(e, seen)) byKey[k] = e
        }
        return byKey.values.toList()
    }

    /**
     * NIP-09: drop what the author deleted. An `e` tag removes that event id; an
     * `a` tag removes every version of that address up to the deletion's time.
     * Only deletions by the post's own author count.
     */
    fun applyDeletions(events: List<NostrEvent>, deletions: List<NostrEvent>): List<NostrEvent> {
        if (deletions.isEmpty()) return events
        val ids = HashMap<String, String>() // id -> deleter
        val addrs = HashMap<String, Long>() // "kind:pubkey:d" -> newest deletion time
        for (del in deletions) {
            if (del.kind != Kinds.DELETION) continue
            del.tagValues("e").forEach { ids[it] = del.pubkey }
            for (a in del.tagValues("a")) {
                // The address must name the deleter's own pubkey.
                val parts = a.split(':', limit = 3)
                if (parts.size == 3 && parts[1] == del.pubkey) addrs[a] = maxOf(addrs[a] ?: 0, del.createdAt)
            }
        }
        return events.filter { e ->
            if (ids[e.id] == e.pubkey) return@filter false
            val at = addrs["${e.kind}:${e.pubkey}:${e.d ?: ""}"]
            at == null || e.createdAt > at
        }
    }

    /** A raw 30023/31607 → [EventPost], decrypting a 31607 with the version its `eck` tag names. */
    fun toEventPost(e: NostrEvent, eck: List<EckVersion>, source: PostSource, now: Long = System.currentTimeMillis() / 1000): EventPost {
        val d = e.d ?: ""
        if (e.kind != Kinds.MEMBERS_POST) {
            return EventPost(
                d = d, kind = e.kind, membersOnly = false, locked = false,
                title = e.tag("title") ?: "Update",
                summary = e.tag("summary"), image = e.tag("image"), content = e.content,
                publishedAt = clampPublishedAt(e.tag("published_at")?.toLongOrNull(), e.createdAt, now),
                editedAt = e.createdAt, source = source, authorPubkey = e.pubkey,
            )
        }
        val version = e.tag("eck")?.toIntOrNull()?.takeIf { it > 0 }
        // The key the POST names, never the current version.
        val key = eck.firstOrNull { it.id == version }
        var newer = false
        if (key != null) {
            val parsed = runCatching {
                val plain = Nip44.eckDecrypt(key.bytes(), e.content)
                Wire.parseSafe(MembersPostContent.serializer(), plain)
            }.getOrNull()
            when (parsed) {
                is Wire.Result.Ok -> {
                    val p = parsed.value
                    return EventPost(
                        d = d, kind = e.kind, membersOnly = true, locked = false,
                        title = p.title, summary = p.summary, image = p.image, content = p.content,
                        publishedAt = clampPublishedAt(p.publishedAt, e.createdAt, now), editedAt = e.createdAt,
                        source = source, authorPubkey = e.pubkey, author = p.author, eckVersion = version,
                    )
                }
                is Wire.Result.Newer -> newer = true
                else -> Unit
            }
        }
        return EventPost(
            d = d, kind = e.kind, membersOnly = true, locked = true, title = "", content = "",
            publishedAt = e.createdAt, editedAt = e.createdAt, source = source, authorPubkey = e.pubkey,
            eckVersion = version, newer = newer,
        )
    }

    fun newestFirst(posts: List<EventPost>): List<EventPost> = posts.sortedByDescending { it.publishedAt }

    /** The relay query for one declared feed (no `until`: an edit after it must stay recoverable). */
    fun externalFeedFilter(src: ExternalFeed): Filter = Filter(
        kinds = listOf(Kinds.LONGFORM),
        authors = listOf(src.pubkey),
        limit = MAX_EXTERNAL_PER_FEED,
        tags = if (!src.tags.isNullOrEmpty()) mapOf("t" to src.tags!!) else emptyMap(),
        since = src.since,
    )

    /** Does this article satisfy what the organizer declared? Re-checked client-side, relays may ignore filters. */
    fun matchesFeed(e: NostrEvent, src: ExternalFeed): Boolean {
        if (e.kind != Kinds.LONGFORM || e.pubkey != src.pubkey) return false
        val wanted = src.tags
        if (!wanted.isNullOrEmpty()) {
            val hashtags = e.tags.filter { it.size >= 2 && it[0] == "t" && it[1].isNotEmpty() }.map { it[1].lowercase() }.toSet()
            if (wanted.none { it.trim().lowercase() in hashtags }) return false
        }
        val publishedAt = e.tag("published_at")?.toLongOrNull()?.takeIf { it > 0 } ?: e.createdAt
        if (src.since != null && publishedAt < src.since!!) return false
        if (src.until != null && publishedAt > src.until!!) return false
        return true
    }

    /**
     * The curated feeds as posts: E_id's own articles excluded (already the
     * official feed), each event kept only if some declared source wants it,
     * at most [MAX_EXTERNAL_PER_FEED] per source, labelled with the feed's name.
     */
    fun externalPosts(eid: String, sources: List<ExternalFeed>, candidates: List<NostrEvent>, now: Long = System.currentTimeMillis() / 1000): List<EventPost> {
        val feeds = sources.filter { it.pubkey != eid }
        if (feeds.isEmpty()) return emptyList()
        val kept = dedupeByD(candidates.filter { e -> feeds.any { matchesFeed(e, it) } })
            .groupBy { it.pubkey }
            .flatMap { (_, v) -> v.sortedByDescending { it.createdAt }.take(MAX_EXTERNAL_PER_FEED) }
        val labels = feeds.mapNotNull { f -> f.label?.trim()?.takeIf { it.isNotEmpty() }?.let { f.pubkey to it } }.toMap()
        return newestFirst(kept.map { toEventPost(it, emptyList(), PostSource.EXTERNAL, now).copy(feedLabel = labels[it.pubkey]) })
    }

    /** The official feed: 30023 ∪ 31607 pinned to E_id, deduped by `d` across both kinds, newest first. */
    fun eventPosts(eid: String, events: List<NostrEvent>, deletions: List<NostrEvent>, eck: List<EckVersion>, now: Long = System.currentTimeMillis() / 1000): List<EventPost> {
        val own = events.filter { it.pubkey == eid && (it.kind == Kinds.LONGFORM || it.kind == Kinds.MEMBERS_POST) }
        val live = dedupeByD(applyDeletions(own, deletions.filter { it.pubkey == eid }))
        return newestFirst(live.map { toEventPost(it, eck, PostSource.EVENT, now) })
    }

    /** Attendee 30023 tagged with the coordinate: never by E_id, only roster members when the roster is known. */
    fun attendeePosts(eid: String, coordinate: String, events: List<NostrEvent>, members: Set<String>?, deletions: List<NostrEvent>, now: Long = System.currentTimeMillis() / 1000): List<EventPost> {
        val raw = events.filter { e ->
            e.kind == Kinds.LONGFORM && e.pubkey != eid && coordinate in e.tagValues("a") && (members == null || e.pubkey in members)
        }
        return newestFirst(dedupeByD(applyDeletions(raw, deletions)).map { toEventPost(it, emptyList(), PostSource.ATTENDEES, now) })
    }

    /** Posts.svelte / a `posts` section: source × visibility, newest first. */
    fun filter(official: List<EventPost>, attendees: List<EventPost>, source: FeedSource, visibility: FeedVisibility): List<EventPost> {
        var list = emptyList<EventPost>()
        if (source != FeedSource.ATTENDEES) list = list + official
        if (source != FeedSource.EVENT) list = list + attendees
        list = when (visibility) {
            FeedVisibility.PUBLIC -> list.filter { !it.membersOnly }
            FeedVisibility.MEMBERS -> list.filter { it.membersOnly }
            FeedVisibility.BOTH -> list
        }
        return newestFirst(list)
    }

    fun sourceOf(s: String) = when (s) { "event" -> FeedSource.EVENT; "attendees" -> FeedSource.ATTENDEES; else -> FeedSource.BOTH }
    fun visibilityOf(s: String) = when (s) { "public" -> FeedVisibility.PUBLIC; "members" -> FeedVisibility.MEMBERS; else -> FeedVisibility.BOTH }

    /**
     * Resolve one post by `d` (posts.ts fetchPostByD): candidates by E_id or by a
     * declared feed that actually wants them; E_id's own post takes the address.
     */
    fun postByD(eid: String, d: String, sources: List<ExternalFeed>, events: List<NostrEvent>, deletions: List<NostrEvent>, eck: List<EckVersion>, now: Long = System.currentTimeMillis() / 1000): EventPost? {
        val candidates = applyDeletions(
            events.filter { (it.d ?: "") == d && (it.kind == Kinds.LONGFORM || it.kind == Kinds.MEMBERS_POST) },
            deletions,
        ).filter { e -> (e.pubkey == eid) || sources.any { matchesFeed(e, it) } }
        val winners = dedupeByD(candidates)
        val winner = winners.firstOrNull { it.pubkey == eid } ?: winners.firstOrNull() ?: return null
        if (winner.pubkey != eid) {
            val label = sources.firstOrNull { it.pubkey == winner.pubkey }?.label?.trim()?.takeIf { it.isNotEmpty() }
            return toEventPost(winner, emptyList(), PostSource.EXTERNAL, now).copy(feedLabel = label)
        }
        return toEventPost(winner, eck, PostSource.EVENT, now)
    }

    /**
     * A home feed expands only the event's own posts inline; curated and attendee
     * posts are teasers (prod feedback 2026-08-29: one long article swallowed the page).
     */
    fun expandsInFeed(p: EventPost): Boolean = p.source == PostSource.EVENT
}
