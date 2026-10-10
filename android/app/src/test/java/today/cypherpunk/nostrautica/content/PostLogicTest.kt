package today.cypherpunk.nostrautica.content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.content.FeedSource
import today.cypherpunk.nostrautica.domain.content.FeedVisibility
import today.cypherpunk.nostrautica.domain.content.PostLogic
import today.cypherpunk.nostrautica.domain.content.PostSource
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.EventPage
import today.cypherpunk.nostrautica.protocol.ExternalFeed
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.MembersPostContent
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent

internal val EID = "a".repeat(64)
internal val ALICE = "b".repeat(64)
internal val BOB = "c".repeat(64)
internal const val COORD_D = "conf"
internal val COORD = "31923:$EID:$COORD_D"
private var seq = 0

internal fun ev(kind: Int, pubkey: String, createdAt: Long, tags: List<List<String>> = emptyList(), content: String = "", id: String? = null) =
    NostrEvent(id ?: "%064x".format(++seq), pubkey, createdAt, kind, tags, content, "0".repeat(128))

internal fun eckV(id: Int, seed: Int = id) = EckVersion(id, Bytes.toBase64(ByteArray(32) { (it + seed).toByte() }))

class PostLogicTest {
    private val now = 2_000_000_000L

    private fun longform(pk: String, d: String, at: Long, title: String = d, published: Long? = null, extra: List<List<String>> = emptyList()) =
        ev(Kinds.LONGFORM, pk, at, listOf(listOf("d", d), listOf("title", title)) + (published?.let { listOf(listOf("published_at", "$it")) } ?: emptyList()) + extra, "body $d")

    private fun members(d: String, at: Long, eck: EckVersion, title: String, published: Long) = ev(
        Kinds.MEMBERS_POST, EID, at, listOf(listOf("d", d), listOf("v", "2"), listOf("eck", "${eck.id}")),
        EventPage.encryptMembersPost(eck.bytes(), MembersPostContent(title = title, publishedAt = published, content = "secret $d")),
    )

    @Test fun dedupesByDAcrossBothKinds() {
        val v1 = eckV(1)
        val pub = longform(EID, "x", 100)
        val mem = members("x", 200, v1, "members x", 50)
        val posts = PostLogic.eventPosts(EID, listOf(pub, mem), emptyList(), listOf(v1), now)
        assertEquals(1, posts.size)
        assertTrue(posts[0].membersOnly)
        assertEquals("members x", posts[0].title)
    }

    @Test fun membersPostUsesTheNamedEckVersionNotTheNewest() {
        val v1 = eckV(1); val v2 = eckV(2)
        val p = members("m", 100, v1, "old key", 90)
        val decrypted = PostLogic.toEventPost(p, listOf(v1, v2), PostSource.EVENT, now)
        assertFalse(decrypted.locked)
        assertEquals("old key", decrypted.title)
        val locked = PostLogic.toEventPost(p, listOf(v2), PostSource.EVENT, now)
        assertTrue(locked.locked)
        assertEquals("", locked.title)
        assertEquals("", locked.content)
    }

    @Test fun newerProtocolMembersPostIsLockedAndFlagged() {
        val v1 = eckV(1)
        val e = ev(Kinds.MEMBERS_POST, EID, 100, listOf(listOf("d", "n"), listOf("eck", "1")),
            Nip44.eckEncrypt(v1.bytes(), """{"v":3,"title":"t","published_at":1,"content":"c","new":{}}"""))
        val p = PostLogic.toEventPost(e, listOf(v1), PostSource.EVENT, now)
        assertTrue(p.locked)
        assertTrue(p.newer)
    }

    @Test fun futurePublishedAtIsClamped() {
        val p = PostLogic.toEventPost(longform(EID, "f", 100, published = now + 10_000), emptyList(), PostSource.EVENT, now)
        assertEquals(now, p.publishedAt)
        assertEquals(100, PostLogic.toEventPost(longform(EID, "g", 100), emptyList(), PostSource.EVENT, now).publishedAt)
    }

    @Test fun officialFeedIsPinnedToEid() {
        val posts = PostLogic.eventPosts(EID, listOf(longform(ALICE, "spoof", 100), longform(EID, "real", 90)), emptyList(), emptyList(), now)
        assertEquals(listOf("real"), posts.map { it.d })
    }

    @Test fun deletionsRemoveByAddressAndId() {
        val a = longform(EID, "a", 100)
        val b = longform(EID, "b", 100)
        val c = longform(EID, "c", 300)
        val delA = ev(Kinds.DELETION, EID, 200, listOf(listOf("a", "${Kinds.LONGFORM}:$EID:a")))
        val delB = ev(Kinds.DELETION, EID, 200, listOf(listOf("e", b.id)))
        val delC = ev(Kinds.DELETION, EID, 200, listOf(listOf("a", "${Kinds.LONGFORM}:$EID:c"))) // older than c: c survives
        val forged = ev(Kinds.DELETION, ALICE, 500, listOf(listOf("a", "${Kinds.LONGFORM}:$EID:c"), listOf("e", c.id)))
        val left = PostLogic.applyDeletions(listOf(a, b, c), listOf(delA, delB, delC, forged))
        assertEquals(listOf(c), left)
    }

    @Test fun attendeeFeedExcludesEidAndNonMembers() {
        val tagA = listOf(listOf("a", COORD))
        val events = listOf(longform(ALICE, "1", 100, extra = tagA), longform(BOB, "2", 110, extra = tagA), longform(EID, "3", 120, extra = tagA), longform(ALICE, "4", 130))
        assertEquals(listOf("2", "1"), PostLogic.attendeePosts(EID, COORD, events, null, emptyList(), now).map { it.d })
        assertEquals(listOf("1"), PostLogic.attendeePosts(EID, COORD, events, setOf(ALICE), emptyList(), now).map { it.d })
    }

    @Test fun externalFeedsHonourDeclaredBounds() {
        val src = ExternalFeed(pubkey = ALICE, tags = listOf("Bitcoin"), since = 100, until = 500, label = "  Alice's blog ")
        val ok = longform(ALICE, "ok", 1000, published = 200, extra = listOf(listOf("t", "bitcoin")))
        val wrongTag = longform(ALICE, "tag", 1000, published = 200, extra = listOf(listOf("t", "cats")))
        val tooOld = longform(ALICE, "old", 1000, published = 50, extra = listOf(listOf("t", "bitcoin")))
        val tooNew = longform(ALICE, "new", 1000, published = 600, extra = listOf(listOf("t", "bitcoin")))
        val stranger = longform(BOB, "bob", 1000, published = 200, extra = listOf(listOf("t", "bitcoin")))
        val out = PostLogic.externalPosts(EID, listOf(src), listOf(ok, wrongTag, tooOld, tooNew, stranger), now)
        assertEquals(listOf("ok"), out.map { it.d })
        assertEquals("Alice's blog", out[0].feedLabel)
        assertEquals(PostSource.EXTERNAL, out[0].source)
        assertTrue(PostLogic.externalPosts(EID, listOf(ExternalFeed(pubkey = EID)), listOf(longform(EID, "self", 1)), now).isEmpty())
    }

    @Test fun externalFilterNeverSendsUntil() {
        val f = PostLogic.externalFeedFilter(ExternalFeed(pubkey = ALICE, tags = listOf("x"), since = 5, until = 9))
        assertEquals(5L, f.since); assertNull(f.until); assertEquals(mapOf("t" to listOf("x")), f.tags)
        assertEquals(PostLogic.MAX_EXTERNAL_PER_FEED, f.limit)
    }

    @Test fun filtersBySourceAndVisibility() {
        val v1 = eckV(1)
        val official = PostLogic.eventPosts(EID, listOf(longform(EID, "pub", 100, published = 100), members("mem", 100, v1, "m", 300)), emptyList(), listOf(v1), now)
        val att = PostLogic.attendeePosts(EID, COORD, listOf(longform(ALICE, "att", 200, published = 200, extra = listOf(listOf("a", COORD)))), null, emptyList(), now)
        assertEquals(listOf("mem", "att", "pub"), PostLogic.filter(official, att, FeedSource.BOTH, FeedVisibility.BOTH).map { it.d })
        assertEquals(listOf("mem", "pub"), PostLogic.filter(official, att, FeedSource.EVENT, FeedVisibility.BOTH).map { it.d })
        assertEquals(listOf("att"), PostLogic.filter(official, att, FeedSource.ATTENDEES, FeedVisibility.BOTH).map { it.d })
        assertEquals(listOf("mem"), PostLogic.filter(official, att, FeedSource.BOTH, FeedVisibility.MEMBERS).map { it.d })
        assertEquals(listOf("att", "pub"), PostLogic.filter(official, att, FeedSource.BOTH, FeedVisibility.PUBLIC).map { it.d })
    }

    @Test fun postByDPrefersEidAndRespectsCuration() {
        val src = ExternalFeed(pubkey = ALICE, tags = listOf("event"))
        val eidPost = longform(EID, "same", 100)
        val alicePost = longform(ALICE, "same", 200, extra = listOf(listOf("t", "event")))
        assertEquals(EID, PostLogic.postByD(EID, "same", listOf(src), listOf(eidPost, alicePost), emptyList(), emptyList(), now)!!.authorPubkey)
        val curated = PostLogic.postByD(EID, "same", listOf(src.copy(label = "A")), listOf(alicePost), emptyList(), emptyList(), now)!!
        assertEquals(PostSource.EXTERNAL, curated.source); assertEquals("A", curated.feedLabel)
        val excluded = longform(ALICE, "other", 200, extra = listOf(listOf("t", "cats")))
        assertNull(PostLogic.postByD(EID, "other", listOf(src), listOf(excluded), emptyList(), emptyList(), now))
        assertNull(PostLogic.postByD(EID, "x", emptyList(), listOf(longform(BOB, "x", 1)), emptyList(), emptyList(), now))
    }
}
