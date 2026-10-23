package today.cypherpunk.nostrautica.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
import today.cypherpunk.nostrautica.signer.MemorySecureStore

/** The Home card's people count (Home.svelte cardFacts) reads only this phone's cache. */
@RunWith(RobolectricTestRunner::class)
class HomeCardFactsTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).allowMainThreadQueries().build()
    private val cache = Cache(db)
    private val nostr = Nostr(ctx, RelayPool(RelayPool.newHttpClient()), EventStore(db), db)
    private val members = Members(nostr, cache, EventKeysStore(MemorySecureStore(ctx)))

    @After fun down() = db.close()

    @Test fun noCachedDirectorySaysNothingAndACachedOneIsCounted() = runBlocking {
        val owner = LocalSigner.generate().pubkey
        val coordinate = "31612:${LocalSigner.generate().pubkey}:club"
        // Never decrypted on this phone: no number at all, rather than a misleading "0 members".
        assertNull(members.observeDirectorySize(owner, coordinate).first())
        val entries = List(3) { DirectoryEntryContent(v = 2, pubkey = LocalSigner.generate().pubkey, profile = AttendeeProfile(), updatedAt = 1_700_000_000L + it) }
        cache.put(owner, "dir:$coordinate", ListSerializer(DirectoryEntryContent.serializer()), entries, 1_700_000_000)
        assertEquals(3, members.observeDirectorySize(owner, coordinate).first())
        // Owner-scoped: another account on the phone sees nothing.
        assertNull(members.observeDirectorySize(LocalSigner.generate().pubkey, coordinate).first())
    }
}
