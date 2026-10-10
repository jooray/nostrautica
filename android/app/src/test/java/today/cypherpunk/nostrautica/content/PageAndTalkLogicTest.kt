package today.cypherpunk.nostrautica.content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.content.PageLogic
import today.cypherpunk.nostrautica.domain.content.PostLogic
import today.cypherpunk.nostrautica.domain.content.PostSource
import today.cypherpunk.nostrautica.domain.content.ResolvedTarget
import today.cypherpunk.nostrautica.domain.content.TalkItem
import today.cypherpunk.nostrautica.domain.content.TalkLogic
import today.cypherpunk.nostrautica.protocol.EventPage
import today.cypherpunk.nostrautica.protocol.EventPageContent
import today.cypherpunk.nostrautica.protocol.EventPagePrivate
import today.cypherpunk.nostrautica.protocol.ExternalFeed
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.MenuItem
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.PageSection
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.TalkContent
import today.cypherpunk.nostrautica.protocol.Wire

class PageAndTalkLogicTest {
    private fun page(at: Long, pub: EventPageContent, menu: List<MenuItem>, author: String = EID, eckId: Int? = null) = ev(
        Kinds.EVENT_PAGE, author, at,
        listOf(listOf("d", COORD_D), listOf("a", COORD), listOf("v", "2")) + (eckId?.let { listOf(listOf("eck", "$it")) } ?: emptyList()) + EventPage.menuToRTags(menu),
        Wire.encode(EventPageContent.serializer(), pub),
    )

    @Test fun mergesPrivateSectionsAndMenuByPos() {
        val v1 = eckV(1)
        val priv = EventPage.encryptPrivate(v1.bytes(), EventPagePrivate(
            menu = listOf(MenuItem("Wifi", "https://wifi.example", pos = 0)),
            sections = listOf(PageSection.Attendees(pos = 1)),
        ))
        val content = EventPageContent(sections = listOf(PageSection.Posts("event", "both"), PageSection.Pinned(listOf("x"))), sources = listOf(ExternalFeed(pubkey = ALICE)), private = priv)
        val e = page(100, content, listOf(MenuItem("Site", "https://site.example")), eckId = 1)
        val member = PageLogic.assemble(EID, listOf(e), listOf(v1))!!
        assertEquals(listOf("Wifi" to true, "Site" to false), member.menu.map { it.label to it.membersOnly })
        assertEquals(listOf(false, true, false), member.sections.map { it.membersOnly })
        assertTrue(member.sections[1].section is PageSection.Attendees)
        assertEquals(ALICE, member.sources.single().pubkey)
        val visitor = PageLogic.assemble(EID, listOf(e), emptyList())!!
        assertEquals(listOf("Site"), visitor.menu.map { it.label })
        assertEquals(2, visitor.sections.size)
    }

    @Test fun pageOnlyFromEidAndNewestWins() {
        val c = EventPageContent(sections = listOf(PageSection.Attendees()))
        assertNull(PageLogic.assemble(EID, listOf(page(100, c, emptyList(), author = ALICE)), emptyList()))
        val newer = page(200, EventPageContent(), listOf(MenuItem("New", "https://n.example")))
        assertEquals("New", PageLogic.assemble(EID, listOf(page(100, c, emptyList()), newer), emptyList())!!.menu.single().label)
    }

    @Test fun newerProtocolPageIsFlagged() {
        val e = ev(Kinds.EVENT_PAGE, EID, 100, listOf(listOf("d", COORD_D)), """{"v":3,"sections":[{"type":"carousel"}]}""")
        assertTrue(PageLogic.assemble(EID, listOf(e), emptyList())!!.newer)
        val bad = ev(Kinds.EVENT_PAGE, EID, 100, listOf(listOf("d", COORD_D)), "not json")
        assertNull(PageLogic.assemble(EID, listOf(bad), emptyList()))
    }

    @Test fun resolvesTargets() {
        val own = Nip19.naddr(Nip19.Addr(Kinds.MEMBERS_POST, EID, "post-d"))
        val foreign = Nip19.naddr(Nip19.Addr(Kinds.LONGFORM, ALICE, "z"))
        assertEquals(ResolvedTarget.Post("post-d"), PageLogic.resolveTarget(EID, "nostr:$own"))
        assertEquals(ResolvedTarget.Naddr(foreign), PageLogic.resolveTarget(EID, "nostr:$foreign"))
        assertEquals(ResolvedTarget.Url("https://x.example/a"), PageLogic.resolveTarget(EID, "https://x.example/a"))
        assertNull(PageLogic.resolveTarget(EID, "http://x.example"))
        assertNull(PageLogic.resolveTarget(EID, "javascript:alert(1)"))
        assertEquals("post-d", PageLogic.pinnedD(EID, own))
        assertNull(PageLogic.pinnedD(EID, foreign))
    }

    @Test fun sectionPostsSkipFeatured() {
        val posts = PostLogic.eventPosts(EID, listOf(
            ev(Kinds.LONGFORM, EID, 100, listOf(listOf("d", "a"))), ev(Kinds.LONGFORM, EID, 200, listOf(listOf("d", "b"))),
        ), emptyList(), emptyList())
        val latest = PageLogic.latest(posts)!!
        assertEquals("b", latest.d)
        assertEquals(listOf("a"), PageLogic.sectionPosts(PageSection.Posts("event", "both"), posts, emptyList(), setOf(latest.key)).map { it.d })
        assertTrue(PostLogic.expandsInFeed(latest))
        assertFalse(PostLogic.expandsInFeed(latest.copy(source = PostSource.EXTERNAL)))
    }

    // ── Talks ───────────────────────────────────────────────────────────────

    private fun talk(speaker: String, talkD: String, rev: Long, status: String = "published", publishedAt: Long = 10) = TalkContent(
        pubkey = speaker, talkD = talkD, title = "T $talkD r$rev", externalUrl = "https://youtu.be/dQw4w9WgXcQ", externalKind = "youtube",
        lang = "en", revision = rev, status = status, publishedAt = publishedAt,
    )

    private fun talkEvent(author: String, eck: today.cypherpunk.nostrautica.protocol.EckVersion, t: TalkContent, at: Long, dOverride: String? = null): today.cypherpunk.nostrautica.protocol.NostrEvent {
        val d = dOverride ?: ProtocolCrypto.talkD(eck.bytes(), COORD, t.pubkey, t.talkD)
        return ev(Kinds.TALK, author, at, listOf(listOf("d", d), listOf("a", COORD), listOf("eck", "${eck.id}"), listOf("v", "2")),
            Nip44.eckEncrypt(eck.bytes(), Wire.encode(TalkContent.serializer(), t)))
    }

    private val coordinator = "d".repeat(64)

    @Test fun talkDDerivationMatchesTheBlindedLiteral() {
        val k = eckV(1).bytes()
        assertEquals(ProtocolCrypto.blindedDLiteral(k, "talk|$COORD|$ALICE|t1"), ProtocolCrypto.talkD(k, COORD, ALICE, "t1"))
        assertEquals(32, ProtocolCrypto.talkD(k, COORD, ALICE, "t1").length)
    }

    @Test fun decodesOnlyTrustedPublishedTalksAtTheirAddress() {
        val v1 = eckV(1)
        val authors = listOf(coordinator, EID)
        val good = talkEvent(coordinator, v1, talk(ALICE, "t1", 1, publishedAt = 50), 100)
        val byEid = talkEvent(EID, v1, talk(BOB, "t2", 1, publishedAt = 60), 100)
        val oldCoordinator = talkEvent("e".repeat(64), v1, talk(BOB, "t3", 1), 100)
        val pending = talkEvent(coordinator, v1, talk(BOB, "t4", 1, status = "pending"), 100)
        val misplaced = talkEvent(coordinator, v1, talk(BOB, "t5", 1), 100, dOverride = "f".repeat(32))
        val r = TalkLogic.decode(COORD, authors, listOf(good, byEid, oldCoordinator, pending, misplaced), emptyList(), listOf(v1))
        assertEquals(listOf("t2", "t1"), r.items.map { it.talk.talkD })
        assertEquals(good.d, r.items[1].d)
        assertTrue(r.sawAny)
    }

    @Test fun rotatedEckRepublishKeepsOneTalkAtHighestRevision() {
        val v1 = eckV(1); val v2 = eckV(2)
        val old = talkEvent(coordinator, v1, talk(ALICE, "t1", 1), 100)
        val new = talkEvent(coordinator, v2, talk(ALICE, "t1", 2), 200)
        val r = TalkLogic.decode(COORD, listOf(coordinator, EID), listOf(old, new), emptyList(), listOf(v1, v2))
        assertEquals(1, r.items.size)
        assertEquals(2L, r.items[0].talk.revision)
        assertEquals(new.d, r.items[0].d)
    }

    @Test fun coordinatorDeletionRemovesARejectedTalk() {
        val v1 = eckV(1)
        val t = talkEvent(coordinator, v1, talk(ALICE, "t1", 1), 100)
        val del = ev(Kinds.DELETION, coordinator, 150, listOf(listOf("a", "${Kinds.TALK}:$coordinator:${t.d}"), listOf("k", "${Kinds.TALK}")))
        val r = TalkLogic.decode(COORD, listOf(coordinator, EID), listOf(t), listOf(del), listOf(v1))
        assertTrue(r.items.isEmpty())
        val prior = listOf(TalkItem(talk(ALICE, "t1", 1), t.d!!))
        assertTrue("explicit deletion empties the cached set", TalkLogic.merge(prior, r).isEmpty())
        val silent = TalkLogic.decode(COORD, listOf(coordinator, EID), emptyList(), emptyList(), listOf(v1))
        assertEquals("an empty answer never blanks a seen talk", prior, TalkLogic.merge(prior, silent))
    }

    @Test fun newerTalkPayloadIsFlaggedNotFatal() {
        val v1 = eckV(1)
        val e = ev(Kinds.TALK, coordinator, 100, listOf(listOf("d", "x"), listOf("a", COORD), listOf("eck", "1")),
            Nip44.eckEncrypt(v1.bytes(), """{"v":3,"pubkey":"$ALICE","talk_d":"q"}"""))
        val r = TalkLogic.decode(COORD, listOf(coordinator), listOf(e), emptyList(), listOf(v1))
        assertTrue(r.newerSeen)
        assertTrue(r.items.isEmpty())
    }
}
