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

    /**
     * Older Android SQLite caps a statement at 999 bound variables, and a roster
     * of a few hundred people in one `IN (…)` gets close; thousands exceed it. So
     * any filter with a long list is split into several filters of at most
     * [MAX_LIST] values each (same meaning: the filters are OR-ed), and the
     * filters are spread over as many statements as needed.
     */
    private fun split(filters: List<Filter>): List<List<Filter>> {
        val expanded = filters.flatMap { f ->
            var parts = listOf(f)
            parts = parts.flatMap { p -> p.ids?.takeIf { it.size > MAX_LIST }?.chunked(MAX_LIST)?.map { p.copy(ids = it) } ?: listOf(p) }
            parts = parts.flatMap { p -> p.authors?.takeIf { it.size > MAX_LIST }?.chunked(MAX_LIST)?.map { p.copy(authors = it) } ?: listOf(p) }
            parts.flatMap { p ->
                val big = p.tags.entries.firstOrNull { it.value.size > MAX_LIST }
                big?.value?.chunked(MAX_LIST)?.map { p.copy(tags = p.tags + (big.key to it)) } ?: listOf(p)
            }
        }
        val groups = mutableListOf<MutableList<Filter>>()
        var vars = 0
        for (f in expanded) {
            val n = (f.ids?.size ?: 0) + (f.authors?.size ?: 0) + (f.kinds?.size ?: 0) + f.tags.values.sumOf { it.size + 1 } + 2
            if (groups.isEmpty() || vars + n > MAX_VARS) { groups += mutableListOf<Filter>(); vars = 0 }
            groups.last() += f
            vars += n
        }
        return groups
    }

    private fun merge(parts: List<List<NostrEvent>>, limit: Int?): List<NostrEvent> {
        val all = parts.flatten().distinctBy { it.id }
            .sortedWith(compareByDescending<NostrEvent> { it.createdAt }.thenBy { it.id })
        return if (limit != null) all.take(limit) else all
    }

    suspend fun query(vararg filters: Filter): List<NostrEvent> {
        val groups = split(filters.toList())
        if (groups.size == 1) return rows(dao.query(sql(groups[0])))
        return merge(groups.map { rows(dao.query(sql(it))) }, filters.mapNotNull { it.limit }.maxOrNull())
    }

    fun observe(vararg filters: Filter): Flow<List<NostrEvent>> {
        val groups = split(filters.toList())
        if (groups.size == 1) return dao.observe(sql(groups[0])).map(::rows)
        val limit = filters.mapNotNull { it.limit }.maxOrNull()
        return kotlinx.coroutines.flow.combine(groups.map { g -> dao.observe(sql(g)).map(::rows) }) { merge(it.toList(), limit) }
    }

    companion object {
        const val MAX_LIST = 400
        const val MAX_VARS = 900
    }

    /** The current version of an addressable/replaceable event, from the phone. */
    suspend fun latest(kind: Int, pubkey: String, d: String? = null): NostrEvent? =
        dao.latest(kind, pubkey, if (Kinds.isAddressable(kind)) d ?: "" else null)?.let { NostrEvent.fromJsonString(it.json) }

    suspend fun delete(id: String) = writeLock.withLock { dao.delete(id); dao.deleteTags(id) }
}
