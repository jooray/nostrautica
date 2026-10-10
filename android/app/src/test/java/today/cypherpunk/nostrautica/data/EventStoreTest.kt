package today.cypherpunk.nostrautica.data

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.UnsignedEvent

@RunWith(RobolectricTestRunner::class)
class EventStoreTest {
    private val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AppDatabase::class.java).allowMainThreadQueries().build()
    private val store = EventStore(db)

    @Test fun queriesMoreAuthorsThanSqliteHasVariables() = runBlocking {
        val signers = (1..2500).map { LocalSigner.generate() }
        store.put(signers.map { it.signNow(UnsignedEvent(it.pubkey, 1_700_000_000, Kinds.PROFILE, emptyList(), "{}")) })
        val f = Filter(kinds = listOf(Kinds.PROFILE), authors = signers.map { it.pubkey })
        assertEquals(2500, store.query(f).size)
        assertEquals(2500, store.observe(f).first().size)
    }

    @Test fun replaceableKeepsOnlyTheLatest() = runBlocking {
        val s = LocalSigner.generate()
        val old = s.signNow(UnsignedEvent(s.pubkey, 100, Kinds.PROFILE, emptyList(), """{"name":"a"}"""))
        val new = s.signNow(UnsignedEvent(s.pubkey, 200, Kinds.PROFILE, emptyList(), """{"name":"b"}"""))
        store.put(listOf(new)); store.put(listOf(old))
        assertEquals(new.id, store.latest(Kinds.PROFILE, s.pubkey)?.id)
        assertEquals(1, store.query(Filter(authors = listOf(s.pubkey))).size)
    }
}
