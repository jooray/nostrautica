package today.cypherpunk.nostrautica.domain.chat

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.EventKeysStore
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.domain.SerializableConfig
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Roster
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterChatKey
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.signer.MemorySecureStore

/**
 * Audit KIMIK31 A-3: a roster the phone answered from its own store (offline, or no
 * relay replied) used to be stamped "fetched now" and read as a fresh "the roster
 * does not list this device", which discarded an attested device key on an import
 * failure, or attested (a coordinator re-enrolment: kick and re-add) on stale data.
 */
@RunWith(RobolectricTestRunner::class)
class RosterProvenanceTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).allowMainThreadQueries().build()
    private val cache = Cache(db)
    // Robolectric's default network has no INTERNET capability: Nostr is offline.
    private val nostr = Nostr(ctx, RelayPool(RelayPool.newHttpClient()), EventStore(db), db)
    private val keys = EventKeysStore(MemorySecureStore(ctx))

    private val eid = LocalSigner.generate()
    private val coordinate = "31923:${eid.pubkey}:x"
    private val ectx = EventContext("naddr1x", coordinate, SerializableConfig(eid.pubkey, listOf(listOf("d", "x"), listOf("v", "2"), listOf("inbox", "ab".repeat(32)))), "t")
    private val owner = LocalSigner.generate().pubkey
    private val oldKey = "d".repeat(64)
    private val newKey = "e".repeat(64)
    private val eck = EckVersion(1, Bytes.toBase64(ByteArray(32) { (it + 7).toByte() }))

    @After fun down() = db.close()

    private suspend fun withEck() = keys.addEckVersions(owner, coordinate, listOf(eck))

    /** A stale roster: this account listed, but only with a key from before the current one. */
    private fun rosterEvent(chatKeys: List<String>, d: String = Roster.page0Ds(coordinate).first(), pages: Int? = null, at: Long = 1_700_000_000): NostrEvent {
        val content = RosterContent(Wire.ROSTER_PAGED_VERSION, 1, "a1".repeat(32), pages, listOf(
            RosterAttendee(owner, "d1", "attendee", chatKeys.map { RosterChatKey(it, null, 1) }),
            RosterAttendee("b".repeat(64), "d2", "attendee"),
        ))
        val body = Nip44.eckEncrypt(eck.bytes(), Wire.json.encodeToString(RosterContent.serializer(), content))
        return eid.signNow(eid.template(Kinds.ROSTER, body, listOf(listOf("d", d), listOf("a", coordinate)), at))
    }

    /** Members whose relay fetch "returns" [fromRelays] (stored, as Nostr.fetch does). */
    private fun members(fromRelays: (List<String>) -> List<NostrEvent> = { emptyList() }) =
        Members(nostr, cache, keys) { _, f ->
            val ds = f.tags["d"].orEmpty()
            fromRelays(ds).also { nostr.store.put(it) }
        }

    @Test fun aStoreOnlyRosterIsNotFromTheNetwork() = runBlocking {
        withEck()
        nostr.store.put(rosterEvent(listOf(oldKey)))
        // The real offline Nostr.fetch path, no seam: nothing came back from a relay.
        val read = Members(nostr, cache, keys).readRoster(ectx, owner)
        assertNotNull(read)
        assertEquals(2, read!!.roster.attendees.size)
        assertFalse("a roster no relay just sent must not count as fresh", read.fromNetwork)
    }

    @Test fun aRosterARelayJustSentIsFromTheNetwork() = runBlocking {
        withEck()
        val e = rosterEvent(listOf(oldKey))
        val read = members { listOf(e) }.readRoster(ectx, owner)!!
        assertTrue(read.fromNetwork)
    }

    @Test fun aStoredPageNewerThanWhatTheRelaysSentIsNotFromTheNetwork() = runBlocking {
        withEck()
        nostr.store.put(rosterEvent(listOf(oldKey), at = 1_700_000_100))
        val older = rosterEvent(listOf(oldKey), at = 1_700_000_000)
        assertFalse(members { listOf(older) }.readRoster(ectx, owner)!!.fromNetwork)
    }

    @Test fun aContinuationPageOnlyInTheStoreIsNotFromTheNetwork() = runBlocking {
        withEck()
        val base = Roster.page0Ds(coordinate).first()
        val page0 = rosterEvent(listOf(oldKey), pages = 2)
        val page1 = rosterEvent(listOf(oldKey), d = "$base:1")
        nostr.store.put(page1)
        val read = members { ds -> if (base in ds) listOf(page0) else emptyList() }.readRoster(ectx, owner)!!
        assertFalse(read.fromNetwork)
        // Positive control: both pages from the relays.
        val both = members { ds -> if (base in ds) listOf(page0) else listOf(page1) }.readRoster(ectx, owner)!!
        assertTrue(both.fromNetwork)
    }

    @Test fun aStoreOnlyReadIsNeitherFreshNorMemoized() = runBlocking {
        withEck()
        nostr.store.put(rosterEvent(listOf(oldKey)))
        val m = Members(nostr, cache, keys)
        var now = 1_000_000L
        val reads = RosterReads { now }
        val f = reads.fetch("k", 0) { m.readRoster(ectx, owner) }!!
        assertFalse(f.fresh)
        // The session's freshness stamp does not move...
        assertEquals(0L, ChatPolicy.rosterFreshAt(0L, f))
        // ...and a reuse window does not turn the store copy into a "fresh" memo.
        now += 1_000
        assertFalse(reads.fetch("k", ChatPolicy.ROSTER_REUSE_MS) { m.readRoster(ectx, owner) }!!.fresh)
    }

    // The audit's test 1: import failure + stale stored roster without the stored key, offline.
    @Test fun anImportFailureNeverDiscardsAKeyOnAStoreOnlyRoster() = runBlocking {
        withEck()
        nostr.store.put(rosterEvent(listOf(oldKey)))
        val m = Members(nostr, cache, keys)
        val f = RosterReads().fetch("k", 0) { m.readRoster(ectx, owner) }
        assertFalse(ChatPolicy.mayReplaceUnimportableKey(f, owner, newKey))
        // Positive control: the same roster, now sent by a relay, does justify it (a
        // later copy, so the store picks this one over the earlier one).
        val e = rosterEvent(listOf(oldKey), at = 1_700_000_100)
        val fresh = RosterReads().fetch("k", 0) { members { listOf(e) }.readRoster(ectx, owner) }
        assertTrue(ChatPolicy.mayReplaceUnimportableKey(fresh, owner, newKey))
    }

    // The audit's tests 2 and 3: a store-only read decides nothing in SETUP or EVICTED.
    @Test fun aStoreOnlyRosterNeverAttests() = runBlocking {
        withEck()
        nostr.store.put(rosterEvent(listOf(oldKey)))
        val m = Members(nostr, cache, keys)
        val now = 10_000_000L
        val f = RosterReads { now }.fetch("k", 0) { m.readRoster(ectx, owner) }!!
        val freshAt = ChatPolicy.rosterFreshAt(0L, f)
        val says = ChatPolicy.rosterSays(f.roster, now - freshAt < ChatPolicy.ROSTER_FRESH_MS, owner, newKey)
        assertEquals(ChatPolicy.RosterSays.UNKNOWN, says)
        val coord = "c".repeat(64)
        // SETUP: no group at all.
        assertTrue(ChatPolicy.decide(emptyList(), GroupBinding.select(emptyList(), f.roster.nostrGroupId, coord), says, f.roster.nostrGroupId, coord, null, false) is ChatPolicy.Decision.Wait)
        // EVICTED before the re-add grace: no immediate rotate-plus-add.
        val evicted = listOf(GroupBinding.GroupInfo("mls-1", f.roster.nostrGroupId!!, coord, listOf(coord), false, false))
        val binding = GroupBinding.select(evicted, f.roster.nostrGroupId, coord)
        assertEquals(GroupBinding.Phase.EVICTED, GroupBinding.phase(binding))
        assertTrue(ChatPolicy.decide(evicted, binding, says, f.roster.nostrGroupId, coord, 1_000, false) is ChatPolicy.Decision.Wait)
    }
}
