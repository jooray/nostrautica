package today.cypherpunk.nostrautica.nostr

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetworkCapabilities
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.NostrEvent

/** The durable outbox's publish/flush policy (audit SB-66 had it untested). */
@RunWith(RobolectricTestRunner::class)
class NostrOutboxTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).allowMainThreadQueries().build()
    init {
        // Robolectric's default network lacks NET_CAPABILITY_INTERNET; Nostr would think it is offline.
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = ShadowNetworkCapabilities.newInstance().also { shadowOf(it).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) }
        shadowOf(cm).setNetworkCapabilities(cm.activeNetwork, caps)
    }
    private val nostr = Nostr(ctx, RelayPool(RelayPool.newHttpClient()), EventStore(db), db)
    private val relays = mutableListOf<FakeRelay>()
    private fun relay() = FakeRelay().also { relays += it }
    private val me = LocalSigner.generate()

    @After fun down() { relays.forEach { it.close() }; db.close() }

    private fun event(s: LocalSigner = me): NostrEvent = s.signNow(s.template(Kinds.APP_DATA, "x", emptyList()))
    private fun refusing(reason: String) = relay().apply { onEvent = { ws, e -> ws.send("""["OK","${e.id}",false,"$reason"]""") } }

    // Audit SB-35: Queued must always have an outbox row behind it.
    @Test fun noRelaysIsRejectedNotQueued() = runBlocking {
        val r = nostr.publish(event(), emptyList(), me.pubkey)
        assertTrue(r is Nostr.PublishResult.Rejected)
        assertEquals(0, db.outbox().all().size)
    }

    // Audit DS41-064: a permanent refusal is an error, not "queued", and is never retried.
    @Test fun aRefusalByEveryRelayIsRejectedAndNotQueued() = runBlocking {
        val a = refusing("blocked: not on the allowlist")
        val r = nostr.publish(event(), listOf(a.url), me.pubkey)
        assertEquals(Nostr.PublishResult.Rejected("blocked: not on the allowlist"), r)
        assertEquals(0, db.outbox().all().size)
        assertEquals("tried once, not three times", 1, a.received.size)
    }

    @Test fun aRefusingRelayIsNotKeptInTheOutboxNextToAnAcceptingOne() = runBlocking {
        val ok = relay()
        val no = refusing("invalid: bad tag")
        val r = nostr.publish(event(), listOf(ok.url, no.url), me.pubkey)
        assertTrue(r is Nostr.PublishResult.Published)
        assertEquals(0, db.outbox().all().size)
    }

    @Test fun aRateLimitIsStillQueued() = runBlocking {
        val slow = refusing("rate-limited: slow down")
        val r = nostr.publish(event(), listOf(slow.url), me.pubkey)
        assertEquals(Nostr.PublishResult.Queued, r)
        assertEquals(1, db.outbox().all().size)
    }

}
