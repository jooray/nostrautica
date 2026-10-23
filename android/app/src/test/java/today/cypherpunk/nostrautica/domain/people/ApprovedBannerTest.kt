package today.cypherpunk.nostrautica.domain.people

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.domain.EventKeysStore
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.signer.MemorySecureStore

/** The "You're approved" banner shows once per owner and event (EventHome.svelte checkApprovalBanner). */
@RunWith(RobolectricTestRunner::class)
class ApprovedBannerTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).allowMainThreadQueries().build()
    private val cache = Cache(db)
    private val nostr = Nostr(ctx, RelayPool(RelayPool.newHttpClient()), EventStore(db), db)
    private val whatsNew = WhatsNew(cache, Members(nostr, cache, EventKeysStore(MemorySecureStore(ctx))))

    @After fun down() = db.close()

    @Test fun showsOnceThenStaysAcknowledged() = runBlocking {
        val owner = LocalSigner.generate().pubkey
        val a = "31923:${LocalSigner.generate().pubkey}:a"
        val b = "31923:${LocalSigner.generate().pubkey}:b"
        assertTrue(whatsNew.approvalIsNew(owner, a, approved = true))
        whatsNew.markApprovedSeen(owner, a)
        assertFalse(whatsNew.approvalIsNew(owner, a, approved = true))
        // Per event and per account.
        assertTrue(whatsNew.approvalIsNew(owner, b, approved = true))
        assertTrue(whatsNew.approvalIsNew(LocalSigner.generate().pubkey, a, approved = true))
        // A later watermark write (People list opened) keeps the acknowledgement.
        whatsNew.markRosterSeen(owner, a, listOf(LocalSigner.generate().pubkey))
        assertFalse(whatsNew.approvalIsNew(owner, a, approved = true))
    }
}
