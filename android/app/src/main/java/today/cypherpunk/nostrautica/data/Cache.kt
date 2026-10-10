package today.cypherpunk.nostrautica.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.data.db.KvRow

/**
 * The app cache (cache/persist.ts): decrypted, derived data keyed per owner. Writes
 * are latest-wins on `at` (the source event's created_at) so a slow fetch can
 * never overwrite something newer. Entries untouched for 30 days are pruned.
 *
 * Plus freshness bookkeeping: [isFresh]/[markFetched] are how screens decide
 * whether to touch the network at all (cache/swr.ts's TTL), which is most of
 * what keeps the app off the data plan.
 */
class Cache(db: AppDatabase) {
    private val dao = db.kv()
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    suspend fun <T> get(scope: String, key: String, s: KSerializer<T>): T? =
        dao.get(scope, key)?.let { runCatching { json.decodeFromString(s, it.data) }.getOrNull() }

    suspend fun getRaw(scope: String, key: String): KvRow? = dao.get(scope, key)

    fun <T> observe(scope: String, key: String, s: KSerializer<T>): Flow<T?> =
        dao.observe(scope, key).map { row -> row?.let { runCatching { json.decodeFromString(s, it.data) }.getOrNull() } }

    fun <T> observePrefix(scope: String, prefix: String, s: KSerializer<T>): Flow<Map<String, T>> =
        dao.observePrefix(scope, prefix).map { rows ->
            rows.mapNotNull { r -> runCatching { json.decodeFromString(s, r.data) }.getOrNull()?.let { r.key to it } }.toMap()
        }

    suspend fun <T> prefix(scope: String, prefix: String, s: KSerializer<T>): Map<String, T> =
        dao.withPrefix(scope, prefix).mapNotNull { r -> runCatching { json.decodeFromString(s, r.data) }.getOrNull()?.let { r.key to it } }.toMap()

    /** Store unless something newer (by [at]) is already there. Returns whether it was written. */
    suspend fun <T> put(scope: String, key: String, s: KSerializer<T>, value: T, at: Long = System.currentTimeMillis() / 1000): Boolean {
        val current = dao.get(scope, key)
        if (current != null && current.at > at) return false
        dao.put(KvRow(scope, key, at, System.currentTimeMillis(), json.encodeToString(s, value)))
        return true
    }

    suspend fun delete(scope: String, key: String) = dao.delete(scope, key)
    suspend fun deletePrefix(scope: String, prefix: String) = dao.deletePrefix(scope, prefix)
    suspend fun dropScope(scope: String) = dao.deleteScope(scope)

    // ── Freshness ───────────────────────────────────────────────────────────

    suspend fun isFresh(key: String, ttlMs: Long): Boolean {
        val r = dao.get(FETCH_SCOPE, key) ?: return false
        return System.currentTimeMillis() - r.touchedAt < ttlMs
    }

    suspend fun lastFetched(key: String): Long? = dao.get(FETCH_SCOPE, key)?.touchedAt

    suspend fun markFetched(key: String) =
        dao.put(KvRow(FETCH_SCOPE, key, 0, System.currentTimeMillis(), ""))

    suspend fun forget(key: String) = dao.delete(FETCH_SCOPE, key)

    suspend fun prune() = dao.pruneUntouched(System.currentTimeMillis() - 30L * 24 * 3600 * 1000)

    companion object {
        const val ANON = "anon"
        private const val FETCH_SCOPE = "\u0001fetch"
    }
}
