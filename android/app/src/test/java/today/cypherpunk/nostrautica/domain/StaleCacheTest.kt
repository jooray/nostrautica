package today.cypherpunk.nostrautica.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.signer.MemorySecureStore

/** A pass that learned nothing must not look like a fresh, authoritative answer. */
@RunWith(RobolectricTestRunner::class)
class StaleCacheTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).allowMainThreadQueries().build()
    private val cache = Cache(db)
    // Robolectric's default network has no INTERNET capability: Nostr is offline, as at a venue.
    private val nostr = Nostr(ctx, RelayPool(RelayPool.newHttpClient()), EventStore(db), db)

    @After fun down() = db.close()

    // Audit DS41-061.
    @Test fun anOfflineProfileRefreshDoesNotMarkProfilesFresh() = runBlocking {
        val pk = LocalSigner.generate().pubkey
        Profiles(nostr, cache).refresh(listOf(pk))
        assertFalse(cache.isFresh("k0:$pk", Profiles.TTL_MS))
    }

    // Audit DS41-056: the empty write used to be stamped "now", so Cache.put refused the real list forever.
    @Test fun anEmptyRosterPassDoesNotSuppressTheRealDirectory() = runBlocking {
        val eid = LocalSigner.generate().pubkey
        val coordinate = "31923:$eid:x"
        val ectx = EventContext("naddr1x", coordinate, SerializableConfig(eid, listOf(listOf("d", "x"), listOf("v", "2"), listOf("inbox", "ab".repeat(32)))), "t")
        val owner = LocalSigner.generate().pubkey
        val members = Members(nostr, cache, EventKeysStore(MemorySecureStore(ctx)))
        members.fetchDirectory(ectx, owner, RosterContent(2, 1, null, null, emptyList()))
        val real = listOf(DirectoryEntryContent(v = 2, pubkey = owner, profile = AttendeeProfile(), updatedAt = 1_700_000_000))
        val ser = ListSerializer(DirectoryEntryContent.serializer())
        cache.put(owner, "dir:$coordinate", ser, real, 1_700_000_000)
        assertEquals(real, members.cachedDirectory(owner, coordinate))
    }
}
