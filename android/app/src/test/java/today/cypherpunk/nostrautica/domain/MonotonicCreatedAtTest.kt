package today.cypherpunk.nostrautica.domain

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetworkCapabilities
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.nostr.FakeRelay
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.signer.MemorySecureStore
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.signer.SignerIntentBridge

/** Audit SB-94: the created_at floor includes the relays' winner, not just this phone's store. */
@RunWith(RobolectricTestRunner::class)
class MonotonicCreatedAtTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).allowMainThreadQueries().build()
    private val relay = FakeRelay()
    init {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = ShadowNetworkCapabilities.newInstance().also { shadowOf(it).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) }
        shadowOf(cm).setNetworkCapabilities(cm.activeNetwork, caps)
    }
    private val pool = RelayPool(RelayPool.newHttpClient())
    private val nostr = Nostr(ctx, pool, EventStore(db), db)
    private val cache = Cache(db)
    private val accounts = Accounts(Session(ctx, MemorySecureStore(ctx), pool, SignerIntentBridge()), nostr, cache)

    @After fun down() { relay.close(); db.close() }

    @Test fun anotherDevicesNewerWriteRaisesTheFloor() = runBlocking {
        val me = LocalSigner.generate()
        val theirs = nowSec() + 100 // written by the PWA, never seen by this phone
        relay.events += me.signNow(me.template(Kinds.APP_DATA, "x", listOf(listOf("d", "backup")), theirs))
        assertEquals(theirs + 1, accounts.monotonicCreatedAt(Kinds.APP_DATA, me.pubkey, "backup", listOf(relay.url)))
    }
}
