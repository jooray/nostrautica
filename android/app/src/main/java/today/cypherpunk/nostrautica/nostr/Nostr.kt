package today.cypherpunk.nostrautica.nostr

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.data.db.OutboxRow
import today.cypherpunk.nostrautica.protocol.NostrEvent

/**
 * The app's one door to Nostr: the relay pool, the local store and the durable
 * outbox (nostr/publish-queue.ts) behind a small API.
 *
 * - [fetch] asks relays and stores what comes back; [local] answers from the
 *   phone. Repositories paint from [local]/[observe] and call [fetch] only when
 *   their data is stale, so an open screen costs nothing on the network twice.
 * - [publish] tries now (three attempts, 0 / 0.5 / 2 s); whatever doesn't reach a
 *   relay is queued and retried when the network comes back or the app returns
 *   to the foreground, on a 15 s / 1 min / 5 min / 15 min backoff, parked as
 *   failed after five attempts for the user to retry or discard. Events that
 *   reached some relays are only carried to the rest, silently.
 */
class Nostr(
    context: Context,
    val pool: RelayPool,
    val store: EventStore,
    db: AppDatabase,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val outbox = db.outbox()
    private val flushLock = Mutex()
    private val json = Json

    private val _network = MutableStateFlow(true)
    /** The phone has a network connection (not the same as relays answering). */
    val network: StateFlow<Boolean> get() = _network

    init {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        _network.value = cm.activeNetwork?.let { cm.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) } == true
        cm.registerNetworkCallback(
            NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    _network.value = true
                    scope.launch { flush(force = false) }
                }
                override fun onLost(network: Network) {
                    _network.value = cm.activeNetwork != null && cm.activeNetwork != network
                }
            },
        )
    }

    // ── Reading ─────────────────────────────────────────────────────────────

    suspend fun fetch(relays: Collection<String>, vararg filters: Filter, timeoutMs: Long = 8_000): RelayPool.FetchResult {
        if (!_network.value) return RelayPool.FetchResult(emptyList(), 0)
        val r = pool.fetch(relays, filters.toList(), timeoutMs)
        store.put(r.events)
        return r
    }

    suspend fun local(vararg filters: Filter): List<NostrEvent> = store.query(*filters)

    fun observe(vararg filters: Filter): Flow<List<NostrEvent>> = store.observe(*filters)

    /** Live events (stored as they arrive). Collect only while a screen needs them. */
    fun live(relays: Collection<String>, vararg filters: Filter): Flow<NostrEvent> =
        pool.subscribe(relays, filters.toList())
            .filterIsInstance<RelayPool.Message.Event>()
            .map { it.event }
            .onEach { store.put(it) }

    // ── Publishing ──────────────────────────────────────────────────────────

    sealed interface PublishResult {
        /** At least one relay accepted it. */
        data class Published(val okRelays: List<String>) : PublishResult
        /** Nobody took it yet; it is in the outbox and will go out later. */
        data object Queued : PublishResult
    }

    suspend fun publish(event: NostrEvent, relays: Collection<String>, owner: String, label: String? = null): PublishResult {
        store.put(event)
        val targets = relays.map(RelayPool::normalize).distinct()
        var missing = targets
        if (_network.value) {
            for (backoff in listOf(0L, 500L, 2_000L)) {
                delay(backoff)
                val outcomes = pool.publish(event, missing)
                missing = missing.filter { outcomes[it] !is RelayPool.PublishOutcome.Ok }
                val rejectedPermanently = outcomes.values.filterIsInstance<RelayPool.PublishOutcome.Rejected>()
                    .all { !isRetryable(it.reason) } && outcomes.values.none { it is RelayPool.PublishOutcome.Timeout }
                if (missing.isEmpty() || (missing.size < targets.size && rejectedPermanently)) break
            }
        }
        val ok = targets - missing.toSet()
        if (missing.isNotEmpty()) enqueue(event, targets, missing, owner, label, partial = ok.isNotEmpty())
        return if (ok.isNotEmpty()) PublishResult.Published(ok) else PublishResult.Queued
    }

    private suspend fun enqueue(event: NostrEvent, relays: List<String>, missing: List<String>, owner: String, label: String?, partial: Boolean) {
        val list = ListSerializer(String.serializer())
        outbox.put(OutboxRow(
            id = event.id, owner = owner, json = event.toJsonString(),
            relays = json.encodeToString(list, relays), missing = json.encodeToString(list, missing),
            attempts = 0, lastAttemptAt = System.currentTimeMillis(), queuedAt = System.currentTimeMillis(),
            failed = false, partial = partial, label = label,
        ))
    }

    fun observeOutbox(owner: String) = outbox.observe(owner)

    suspend fun discard(id: String) = outbox.delete(id)

    suspend fun retry(id: String) {
        outbox.all().firstOrNull { it.id == id }?.let { outbox.put(it.copy(failed = false, attempts = 0, lastAttemptAt = 0)) }
        flush(force = true)
    }

    suspend fun discardOwner(owner: String) = outbox.deleteOwner(owner)

    /** Retry what is due. Called on reconnect, on foreground, and after a publish elsewhere succeeds. */
    suspend fun flush(force: Boolean) = flushLock.withLock {
        if (!_network.value) return@withLock
        val list = ListSerializer(String.serializer())
        val now = System.currentTimeMillis()
        for (row in outbox.all()) {
            if (row.failed && !force) continue
            val due = row.lastAttemptAt + BACKOFF_MS[minOf(row.attempts, BACKOFF_MS.size - 1)]
            if (!force && now < due) continue
            val event = NostrEvent.fromJsonString(row.json) ?: run { outbox.delete(row.id); null } ?: continue
            val missing = json.decodeFromString(list, row.missing)
            val outcomes = pool.publish(event, missing)
            val still = missing.filter { outcomes[it] !is RelayPool.PublishOutcome.Ok }
            val reachedAny = still.size < missing.size || row.partial
            when {
                still.isEmpty() -> outbox.delete(row.id)
                row.attempts + 1 >= MAX_ATTEMPTS -> {
                    // A partially delivered event already exists on the network: stop quietly.
                    if (reachedAny) outbox.delete(row.id)
                    else outbox.put(row.copy(attempts = row.attempts + 1, lastAttemptAt = now, failed = true, missing = json.encodeToString(list, still)))
                }
                else -> outbox.put(row.copy(attempts = row.attempts + 1, lastAttemptAt = now, partial = reachedAny, missing = json.encodeToString(list, still)))
            }
        }
    }

    fun onForeground() {
        pool.setForeground(true)
        scope.launch { runCatching { flush(force = false) }.onFailure { Log.w("Nostr", "flush", it) } }
    }

    fun onBackground() = pool.setForeground(false)

    companion object {
        private val BACKOFF_MS = longArrayOf(0, 15_000, 60_000, 300_000, 900_000)
        private const val MAX_ATTEMPTS = 5

        /** nostr/errors.ts: rate limits and transient errors retry; policy refusals don't. */
        fun isRetryable(reason: String): Boolean {
            val r = reason.lowercase()
            if (r.startsWith("blocked") || r.startsWith("invalid") || r.startsWith("pow") || r.startsWith("restricted") ||
                r.startsWith("auth-required") || r.contains("payment")) return false
            return true
        }
    }
}
