package today.cypherpunk.nostrautica.domain.media

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.data.db.AppDatabase

/** The NIP §3.3 rev ordering a failed relay read must never roll back (submit.ts nextRev). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RevCountersTest {
    private val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AppDatabase::class.java).allowMainThreadQueries().build()
    private val revs = RevCounters(Cache(db))
    private val me = "a".repeat(64)
    private val ev = "31923:${"b".repeat(64)}:x"

    @After fun close() = db.close()

    @Test fun strictlyIncreasingEvenWhenTheReadComesBackEmpty() = runBlocking {
        assertEquals(0L, revs.next(me, ev, null))
        assertEquals(1L, revs.next(me, ev, null))
        // An empty relay read (observed = null) used to restart at 0.
        assertEquals(2L, revs.next(me, ev, null))
        // Another device further ahead wins.
        assertEquals(8L, revs.next(me, ev, 7))
        // A stale observation never lowers it.
        assertEquals(9L, revs.next(me, ev, 1))
    }

    @Test fun raisingDoesNotConsume() = runBlocking {
        revs.raise(me, ev, 5)
        revs.raise(me, ev, 3)
        assertEquals(6L, revs.next(me, ev, null))
    }

    @Test fun scopedPerOwnerAndEvent() = runBlocking {
        revs.next(me, ev, 10)
        assertEquals(0L, revs.next("c".repeat(64), ev, null))
        assertEquals(0L, revs.next(me, "$ev-2", null))
    }

    @Test fun correctionRevIsMonotonicAcrossDevices() = runBlocking {
        assertEquals(0L, revs.claimCorrection(me, ev, null))
        // The relay-backed self-copy says another device reached 4.
        assertEquals(5L, revs.claimCorrection(me, ev, 4))
        assertEquals(6L, revs.claimCorrection(me, ev, null))
        revs.raiseCorrection(me, ev, 2)
        assertEquals(6L, revs.correctionFloor(me, ev))
    }
}
