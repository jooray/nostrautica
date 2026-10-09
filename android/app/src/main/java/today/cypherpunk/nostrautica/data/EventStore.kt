package today.cypherpunk.nostrautica.data

import androidx.sqlite.db.SimpleSQLiteQuery
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.data.db.EventRow
import today.cypherpunk.nostrautica.data.db.TagRow
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering

/**
 * The local event store: every verified event the app has seen, so every screen
 * paints from the phone first and works offline. Replaceable and addressable
 * events keep only the current version under the NIP §3.1 latest-event rule.
 */
class EventStore(private val db: AppDatabase) {
    private val dao = db.events()
    private val writeLock = Mutex()

    private fun dOf(e: NostrEvent): String? = when {
        Kinds.isAddressable(e.kind) -> e.d ?: ""
        else -> null
    }

    private fun tagRows(e: NostrEvent) = e.tags
        .filter { it.size >= 2 && it[0].length == 1 && it[1].length <= 512 }
        .map { TagRow(e.id, it[0], it[1]) }
        .distinct()

    /** Store events (already verified by the pool). Returns those that were new or newer. */
    suspend fun put(events: Collection<NostrEvent>): List<NostrEvent> = writeLock.withLock {
        val changed = mutableListOf<NostrEvent>()
        val fresh = if (events.isEmpty()) emptySet() else events.map { it.id }.chunked(500).flatMap { dao.existing(it) }.toSet()
        for (e in events) {
            if (e.id in fresh) continue
            val row = EventRow(e.id, e.kind, e.pubkey, dOf(e), e.createdAt, e.toJsonString(), System.currentTimeMillis())
            if (Kinds.isReplaceable(e.kind) || Kinds.isAddressable(e.kind)) {
                val current = dao.latest(e.kind, e.pubkey, row.d)
                if (current != null && Ordering.compareLatest(current.id, current.createdAt, e.id, e.createdAt) <= 0) continue
                dao.replace(current?.id, row, tagRows(e))
            } else {
                dao.replace(null, row, tagRows(e))
            }
            changed += e
        }
        changed
    }

    suspend fun put(e: NostrEvent) = put(listOf(e))

    private fun sql(filters: List<Filter>): SimpleSQLiteQuery {
        val clauses = mutableListOf<String>()
        val args = mutableListOf<Any>()
        for (f in filters) {
            val c = mutableListOf<String>()
            f.ids?.let { c += "e.id IN (${it.joinToString(",") { "?" }})"; args.addAll(it) }
            f.authors?.let { c += "e.pubkey IN (${it.joinToString(",") { "?" }})"; args.addAll(it) }
            f.kinds?.let { c += "e.kind IN (${it.joinToString(",") { "?" }})"; args.addAll(it) }
            f.since?.let { c += "e.createdAt >= ?"; args.add(it) }
            f.until?.let { c += "e.createdAt <= ?"; args.add(it) }
            for ((name, values) in f.tags) {
                c += "EXISTS (SELECT 1 FROM event_tags t WHERE t.eventId = e.id AND t.name = ? AND t.value IN (${values.joinToString(",") { "?" }}))"
                args.add(name); args.addAll(values)
            }
            clauses += if (c.isEmpty()) "1" else c.joinToString(" AND ", "(", ")")
        }
        val limit = filters.mapNotNull { it.limit }.maxOrNull()
        val q = "SELECT e.* FROM events e WHERE ${clauses.joinToString(" OR ")} ORDER BY e.createdAt DESC, e.id ASC" +
            (if (limit != null) " LIMIT $limit" else "")
        return SimpleSQLiteQuery(q, args.toTypedArray())
    }

    private fun rows(r: List<EventRow>) = r.mapNotNull { NostrEvent.fromJsonString(it.json) }

    suspend fun query(vararg filters: Filter): List<NostrEvent> = rows(dao.query(sql(filters.toList())))

    fun observe(vararg filters: Filter): Flow<List<NostrEvent>> = dao.observe(sql(filters.toList())).map(::rows)

    /** The current version of an addressable/replaceable event, from the phone. */
    suspend fun latest(kind: Int, pubkey: String, d: String? = null): NostrEvent? =
        dao.latest(kind, pubkey, if (Kinds.isAddressable(kind)) d ?: "" else null)?.let { NostrEvent.fromJsonString(it.json) }

    suspend fun delete(id: String) = writeLock.withLock { dao.delete(id); dao.deleteTags(id) }
}
