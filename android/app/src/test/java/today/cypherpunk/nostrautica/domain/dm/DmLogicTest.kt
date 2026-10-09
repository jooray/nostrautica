package today.cypherpunk.nostrautica.domain.dm

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.DmReadPosition
import today.cypherpunk.nostrautica.protocol.DmReadState
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.Wire

class DmLogicTest {
    private val alice = LocalSigner.generate()
    private val bob = LocalSigner.generate()
    private fun hex(n: Int) = n.toString(16).padStart(64, '0')
    private fun msg(id: Int, peer: String, from: String, at: Long, text: String = "m$id") = DmMessage(hex(id), peer, from, text, at)

    // ── Wrap / unwrap ───────────────────────────────────────────────────────

    @Test fun sendProducesTwoWrapsOfOneRumor() = runTest {
        val out = DmLogic.wrapDm(alice, bob.pubkey, "hi bob", now = 1_700_000_000)
        assertNotEquals(out.toRecipient.id, out.toSelf.id)
        assertEquals(listOf(listOf("p", bob.pubkey)), out.toRecipient.tags)
        assertEquals(listOf(listOf("p", alice.pubkey)), out.toSelf.tags)
        // The wraps are signed by one-time keys, never the author.
        assertNotEquals(alice.pubkey, out.toRecipient.pubkey)
        assertNotEquals(out.toRecipient.pubkey, out.toSelf.pubkey)

        val received = GiftWrap.unwrap(out.toRecipient, bob, Kinds.ATTENDEE_RUMOR_KINDS)
        val selfCopy = GiftWrap.unwrap(out.toSelf, alice, Kinds.ATTENDEE_RUMOR_KINDS)
        assertEquals(out.rumorId, received.id)
        assertEquals(received.id, selfCopy.id)

        val atBob = DmLogic.classify(received, bob.pubkey)!!
        assertEquals(alice.pubkey, atBob.peer); assertEquals(alice.pubkey, atBob.from); assertEquals("hi bob", atBob.text)
        val atAlice = DmLogic.classify(selfCopy, alice.pubkey)!!
        assertEquals(bob.pubkey, atAlice.peer); assertEquals(alice.pubkey, atAlice.from)
        assertEquals(1_700_000_000L, atAlice.at)
    }

    @Test fun aWrapForSomeoneElseDoesNotOpen() = runTest {
        val out = DmLogic.wrapDm(alice, bob.pubkey, "secret")
        try {
            GiftWrap.unwrap(out.toRecipient, alice, Kinds.ATTENDEE_RUMOR_KINDS)
            fail("alice must not open bob's copy")
        } catch (e: Exception) { /* expected: MAC failure */ }
    }

    @Test fun classifyRejectsNonDmsAndMissingRecipients() {
        fun rumor(kind: Int, tags: List<List<String>>) = Rumor(hex(1), alice.pubkey, 1, kind, tags, "x")
        assertNull(DmLogic.classify(rumor(Kinds.KEY_GRANT, listOf(listOf("p", bob.pubkey))), bob.pubkey))
        assertNull(DmLogic.classify(rumor(Kinds.DM, emptyList()), bob.pubkey))
        assertNull(DmLogic.classify(rumor(Kinds.DM, listOf(listOf("p", "not-hex"))), alice.pubkey))
        // A note to self is a thread with yourself.
        val self = DmLogic.classify(Rumor(hex(2), alice.pubkey, 1, Kinds.DM, listOf(listOf("p", alice.pubkey)), "memo"), alice.pubkey)!!
        assertEquals(alice.pubkey, self.peer)
    }

    // ── Memo and threads ────────────────────────────────────────────────────

    @Test fun snapshotDedupesCopiesByRumorIdAndKeepsTheOutboxLink() {
        val sent = msg(1, bob.pubkey, alice.pubkey, 10).copy(outWrap = hex(99))
        val memo = mapOf(
            "w-self" to DmMemoEntry(sent, 5),
            "w-dup" to DmMemoEntry(sent.copy(outWrap = null), 6),
            "w-grant" to DmMemoEntry(null, 7),
            "w-in" to DmMemoEntry(msg(2, bob.pubkey, bob.pubkey, 20), 8),
        )
        val snap = DmLogic.snapshot(memo)
        assertEquals(listOf(hex(1), hex(2)), snap.map { it.id })
        assertEquals(hex(99), snap[0].outWrap)
    }

    @Test fun memoCapKeepsTheNewestWraps() {
        val memo = (1..10).associate { "w$it" to DmMemoEntry(if (it % 2 == 0) null else msg(it, bob.pubkey, bob.pubkey, it * 10L), it.toLong()) }
        val capped = DmLogic.capMemo(memo, 4)
        assertEquals(setOf("w7", "w8", "w9", "w10"), capped.keys)
        assertEquals(memo, DmLogic.capMemo(memo, 10))
    }

    @Test fun threadsGroupPerPeerNewestFirst() {
        val carol = LocalSigner.generate().pubkey
        val msgs = listOf(
            msg(1, bob.pubkey, bob.pubkey, 10), msg(2, carol, alice.pubkey, 30),
            msg(3, bob.pubkey, alice.pubkey, 20), msg(4, bob.pubkey, bob.pubkey, 40),
        )
        val threads = DmLogic.threadsOf(msgs)
        assertEquals(listOf(bob.pubkey, carol), threads.map { it.peer })
        assertEquals(3, threads[0].count)
        assertEquals(hex(4), threads[0].last.id)
    }

    // ── Relays and the scan cursor ──────────────────────────────────────────

    @Test fun dmRelaysNeverCrowdOutDefaults() {
        val theirs = (1..40).map { "wss://inbox$it.example" } + listOf("ws://evil.example", "https://not-a-relay", Relays.DEFAULT[0] + "/")
        val sel = DmLogic.selectDmRelays(theirs)
        assertEquals(Relays.MAX_DM_RELAYS, sel.size)
        assertTrue(sel.containsAll(Relays.DEFAULT))
        assertFalse(sel.any { it.startsWith("ws://evil") || it.startsWith("https") })
        assertEquals(Relays.DEFAULT, DmLogic.selectDmRelays(emptyList()))
        assertTrue(DmLogic.isAcceptedRelayUrl("ws://localhost:7777"))
        assertEquals(listOf("wss://a.example"), DmLogic.relayUrlsFromDmList(listOf(listOf("relay", "wss://a.example/"), listOf("r", "wss://b.example"))))
    }

    @Test fun historyCursorAlwaysMovesBack() {
        assertEquals(500L, DmLogic.nextHistoryUntil(null, 500))
        assertEquals(400L, DmLogic.nextHistoryUntil(500, 400))
        // A relay returning the same full boundary page again is forced one second back.
        assertEquals(499L, DmLogic.nextHistoryUntil(500, 500))
        val now = 10_000_000L
        assertEquals(GiftWrap.since(now), DmLogic.steadySince(DmScanState(), now))
        assertEquals(GiftWrap.since(now), DmLogic.steadySince(DmScanState(lastScan = now - 60), now))
        assertEquals(now - 30 * 86_400 - 86_400, DmLogic.steadySince(DmScanState(lastScan = now - 30 * 86_400), now))
    }

    // ── Read state ──────────────────────────────────────────────────────────

    @Test fun watermarkMergeIsPerPeerMaxAndCommutative() {
        val a = mapOf("p1" to DmReadPosition(5, hex(5)), "p2" to DmReadPosition(3, hex(3)))
        val b = mapOf("p1" to DmReadPosition(4, hex(9)), "p3" to DmReadPosition(1, hex(1)))
        val ab = DmLogic.mergeWatermarks(a, b)
        assertTrue(DmLogic.sameWatermarks(ab, DmLogic.mergeWatermarks(b, a)))
        assertEquals(DmReadPosition(5, hex(5)), ab["p1"])
        assertEquals(3, ab.size)
        // Same second: the id breaks the tie, so devices agree.
        val tie = DmLogic.mergeWatermarks(mapOf("p" to DmReadPosition(5, hex(1))), mapOf("p" to DmReadPosition(5, hex(2))))
        assertEquals(hex(2), tie["p"]!!.id)
        assertFalse(DmLogic.sameWatermarks(a, b))
    }

    @Test fun unreadCountsRespectWatermarksAndReplies() {
        val me = alice.pubkey
        val b = bob.pubkey
        val msgs = listOf(msg(1, b, b, 10), msg(2, b, b, 20), msg(3, b, me, 30), msg(4, b, b, 40))
        // Replying is reading: only what came after my reply counts.
        assertEquals(1, DmLogic.threadUnread(msgs, me, b, emptyMap()))
        assertEquals(mapOf(b to 1), DmLogic.unreadByPeer(msgs, me, emptyMap()))
        val read = DmLogic.markThreadRead(emptyMap(), msgs, me, b)!!
        assertEquals(DmReadPosition(40, hex(4)), read[b])
        assertEquals(0, DmLogic.threadUnread(msgs, me, b, read))
        assertNull(DmLogic.markThreadRead(read, msgs, me, b)) // nothing moved
        assertEquals(4 - 1, DmLogic.incomingUnreadCount(msgs, me))
    }

    @Test fun markAllReadIsIdempotentAndNeverRegresses() {
        val me = alice.pubkey
        val carol = LocalSigner.generate().pubkey
        val msgs = listOf(msg(1, bob.pubkey, bob.pubkey, 10), msg(2, carol, carol, 20), msg(3, carol, me, 25))
        val ahead = mapOf(bob.pubkey to DmReadPosition(99, hex(99)))
        val all = DmLogic.markAllRead(ahead, msgs, me)!!
        assertEquals(DmReadPosition(99, hex(99)), all[bob.pubkey])
        assertEquals(DmReadPosition(20, hex(2)), all[carol])
        assertNull(DmLogic.markAllRead(all, msgs, me))
        assertTrue(DmLogic.unreadByPeer(msgs, me, all).isEmpty())
    }

    @Test fun publishedMapIsSanitizedAndCapped() {
        val many = (1..250).associate { hex(it) to DmReadPosition(it.toLong(), hex(it)) } + mapOf("bad" to DmReadPosition(1, hex(1)), hex(999) to DmReadPosition(1, "short"))
        val pruned = DmLogic.prunedForPublish(many)
        assertEquals(200, pruned.size)
        assertTrue(hex(250) in pruned && hex(50) !in pruned)
        assertFalse("bad" in pruned || hex(999) in pruned)
        // And it round-trips through the wire schema the other devices parse.
        val json = Wire.json.encodeToString(DmReadState.serializer(), DmReadState(threads = pruned))
        val back = Wire.parseSafe(DmReadState.serializer(), json)
        assertTrue(back is Wire.Result.Ok && DmLogic.sameWatermarks(back.value.threads, pruned))
    }

    @Test fun activityLedgerBaselinesThenFlagsNewWraps() {
        val first = DmLogic.observeActivity(DmActivity(), listOf("a", "b"))
        assertTrue(first.initialized); assertTrue(first.pending.isEmpty())
        val second = DmLogic.observeActivity(first, listOf("b", "c"))
        assertEquals(listOf("c"), second.pending)
        assertEquals(listOf("a", "b", "c"), second.known)
    }

    // ── Mutes and the header's event pick ───────────────────────────────────

    @Test fun muteMergeKeepsEverythingElse() {
        val s = DmMutes.State(listOf(listOf("p", "pub"), listOf("t", "spam")), listOf(listOf("word", "x")))
        val muted = DmMutes.addPrivate(s, "bob")
        assertEquals(listOf(listOf("word", "x"), listOf("p", "bob")), muted.privateTags)
        assertEquals(muted, DmMutes.addPrivate(muted, "bob"))
        assertEquals(s, DmMutes.addPrivate(s, "pub")) // already muted publicly
        val unmuted = DmMutes.remove(DmMutes.remove(muted, "bob"), "pub")
        assertEquals(listOf(listOf("t", "spam")), unmuted.publicTags)
        assertEquals(setOf<String>(), unmuted.muted)
        assertEquals(muted.privateTags, DmMutes.parsePrivate(DmMutes.encodePrivate(muted.privateTags)))
        assertTrue(DmMutes.parsePrivate("not json").isEmpty())
    }

    @Test fun primaryEventIsTheSoonestLiveElseMostRecent() {
        val now = 1_000_000L
        val past = SharedEvent("old", "n1", "c1", now - 900, now - 800)
        val recent = SharedEvent("recent", "n2", "c2", now - 300, now - 200)
        val later = SharedEvent("later", "n3", "c3", now + 5_000, now + 6_000)
        val soon = SharedEvent("soon", "n4", "c4", now + 100, null)
        assertEquals("soon", DmPeer.primary(listOf(past, later, soon), now)?.title)
        assertEquals("recent", DmPeer.primary(listOf(past, recent), now)?.title)
        assertNull(DmPeer.primary(emptyList(), now))
    }
}
