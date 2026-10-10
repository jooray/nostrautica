package today.cypherpunk.nostrautica.data.db

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RawQuery
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.sqlite.db.SupportSQLiteQuery
import kotlinx.coroutines.flow.Flow

/** A verified Nostr event as received. `d` is set for addressable kinds. */
@Entity(
    tableName = "events",
    primaryKeys = ["id"],
    indices = [Index(value = ["kind", "pubkey", "d"]), Index(value = ["kind", "createdAt"])],
)
data class EventRow(
    val id: String,
    val kind: Int,
    val pubkey: String,
    val d: String?,
    val createdAt: Long,
    val json: String,
    val receivedAt: Long,
)

/** Single-letter tag index (`#a`, `#p`, `#d`, `#h`, `#e`, `#t`), so filters can be answered locally. */
@Entity(
    tableName = "event_tags",
    primaryKeys = ["eventId", "name", "value"],
    indices = [Index(value = ["name", "value"])],
)
data class TagRow(val eventId: String, val name: String, val value: String)

/**
 * The app cache (cache/persist.ts): owner-scoped key → JSON, latest-wins on `at`
 * (the source event's created_at). Scope "anon" holds public data, otherwise the
 * owner's pubkey, so logout can drop exactly one account's decrypted data.
 */
@Entity(tableName = "kv", primaryKeys = ["scope", "key"], indices = [Index("touchedAt")])
data class KvRow(val scope: String, val key: String, val at: Long, val touchedAt: Long, val data: String)

/** Durable outbox (nostr/publish-queue.ts). */
@Entity(tableName = "outbox", primaryKeys = ["id"])
data class OutboxRow(
    val id: String,
    val owner: String,
    val json: String,
    val relays: String,
    val missing: String,
    val attempts: Int,
    val lastAttemptAt: Long,
    val queuedAt: Long,
    val failed: Boolean,
    val partial: Boolean,
    val label: String?,
)

@Dao
interface EventDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: EventRow): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertTags(rows: List<TagRow>)

    @Query("SELECT * FROM events WHERE kind = :kind AND pubkey = :pubkey AND ((:d IS NULL AND d IS NULL) OR d = :d) ORDER BY createdAt DESC, id ASC LIMIT 1")
    suspend fun latest(kind: Int, pubkey: String, d: String?): EventRow?

    @Query("DELETE FROM events WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM event_tags WHERE eventId = :id")
    suspend fun deleteTags(id: String)

    @Query("SELECT id FROM events WHERE id IN (:ids)")
    suspend fun existing(ids: List<String>): List<String>

    @RawQuery(observedEntities = [EventRow::class])
    suspend fun query(q: SupportSQLiteQuery): List<EventRow>

    @RawQuery(observedEntities = [EventRow::class])
    fun observe(q: SupportSQLiteQuery): Flow<List<EventRow>>

    @Query("SELECT COUNT(*) FROM events")
    suspend fun count(): Int

    @Query("DELETE FROM events WHERE receivedAt < :before AND kind IN (:kinds)")
    suspend fun pruneKinds(before: Long, kinds: List<Int>)

    @Transaction
    suspend fun replace(oldId: String?, row: EventRow, tags: List<TagRow>) {
        if (oldId != null) { delete(oldId); deleteTags(oldId) }
        insert(row)
        insertTags(tags)
    }
}

@Dao
interface KvDao {
    @Query("SELECT * FROM kv WHERE scope = :scope AND `key` = :key")
    suspend fun get(scope: String, key: String): KvRow?

    @Query("SELECT * FROM kv WHERE scope = :scope AND `key` = :key")
    fun observe(scope: String, key: String): Flow<KvRow?>

    @Query("SELECT * FROM kv WHERE scope = :scope AND `key` LIKE :prefix || '%'")
    suspend fun withPrefix(scope: String, prefix: String): List<KvRow>

    @Query("SELECT * FROM kv WHERE scope = :scope AND `key` LIKE :prefix || '%'")
    fun observePrefix(scope: String, prefix: String): Flow<List<KvRow>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: KvRow)

    @Query("DELETE FROM kv WHERE scope = :scope AND `key` = :key")
    suspend fun delete(scope: String, key: String)

    @Query("DELETE FROM kv WHERE scope = :scope AND `key` LIKE :prefix || '%'")
    suspend fun deletePrefix(scope: String, prefix: String)

    @Query("DELETE FROM kv WHERE scope = :scope")
    suspend fun deleteScope(scope: String)

    @Query("DELETE FROM kv WHERE touchedAt < :before")
    suspend fun pruneUntouched(before: Long)
}

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: OutboxRow)

    @Query("SELECT * FROM outbox WHERE owner = :owner ORDER BY queuedAt")
    suspend fun forOwner(owner: String): List<OutboxRow>

    @Query("SELECT * FROM outbox WHERE owner = :owner ORDER BY queuedAt")
    fun observe(owner: String): Flow<List<OutboxRow>>

    @Query("SELECT * FROM outbox ORDER BY queuedAt")
    suspend fun all(): List<OutboxRow>

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM outbox WHERE owner = :owner")
    suspend fun deleteOwner(owner: String)
}

@Database(entities = [EventRow::class, TagRow::class, KvRow::class, OutboxRow::class], version = 1, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun events(): EventDao
    abstract fun kv(): KvDao
    abstract fun outbox(): OutboxDao

    companion object {
        fun open(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "nostrautica.db")
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}
