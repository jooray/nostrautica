package today.cypherpunk.nostrautica.domain

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.signer.SecureStore

/** Audit R-68: the logout lock is bounded and says how much it left in plaintext. */
@RunWith(RobolectricTestRunner::class)
class LogoutLockTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val secure = object : SecureStore(ctx) {
        override fun seal(value: String) = value
        override fun unseal(raw: String): String? = raw
    }
    private val store = EventKeysStore(secure)
    private val owner = LocalSigner.generate()
    private val coord = "31923:" + "ab".repeat(32) + ":ev"

    /** A remote signer that never answers. */
    private val stuck = object : NostrSigner {
        override val pubkey = owner.pubkey
        override val isLocal = false
        override suspend fun sign(event: UnsignedEvent): NostrEvent = awaitCancellation()
        override suspend fun nip44Encrypt(peerPubkey: String, plaintext: String): String = awaitCancellation()
        override suspend fun nip44Decrypt(peerPubkey: String, ciphertext: String): String = awaitCancellation()
    }

    @Test fun aSignerThatNeverAnswersCostsTheDeadlineAndIsReported() = runBlocking {
        store.save(owner.pubkey, EventKeys(coord, "organizer", eidNsecHex = "11".repeat(32)))
        val started = System.currentTimeMillis()
        val left = store.lockForLogout(owner.pubkey, stuck, deadlineMs = 300)
        assertTrue(System.currentTimeMillis() - started < 5_000)
        assertEquals(1, left)
        // Left in place rather than lost.
        assertNotNull(store.get(owner.pubkey, coord))
    }

    @Test fun aWorkingSignerLocksEverything() = runBlocking {
        store.save(owner.pubkey, EventKeys(coord, "organizer", eidNsecHex = "11".repeat(32)))
        assertEquals(0, store.lockForLogout(owner.pubkey, owner))
        assertNull(store.get(owner.pubkey, coord))
        assertTrue(store.unlockForLogin(owner.pubkey, owner))
        assertEquals("11".repeat(32), store.get(owner.pubkey, coord)?.eidNsecHex)
    }
}
