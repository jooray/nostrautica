package today.cypherpunk.nostrautica.nostr

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.NostrEvent
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * NIP-01 relay pool over OkHttp WebSockets.
 *
 * Battery and data are the design constraint: a socket is opened only when
 * something needs it (a subscription or a publish), closed after [IDLE_CLOSE_MS]
 * with nothing open on it, and every socket is closed shortly after the app goes
 * to the background ([setForeground]). There is no background polling at all;
 * screens fetch when they open (cache first) and hold live subscriptions only
 * while visible.
 *
 * Every event is signature-checked before anyone sees it, and deduplicated per
 * subscription.
 */
class RelayPool(private val http: OkHttpClient) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val relays = ConcurrentHashMap<String, Relay>()
    private val subIds = AtomicLong()
    @Volatile private var foreground = true
    private var backgroundJob: Job? = null

    private val _online = MutableStateFlow(true)
    /** At least one relay socket is up (or nothing has needed one yet). */
    val online: StateFlow<Boolean> get() = _online

    /** Called by the process lifecycle observer. */
    fun setForeground(value: Boolean) {
        foreground = value
        backgroundJob?.cancel()
        if (!value) {
            backgroundJob = scope.launch {
                delay(BACKGROUND_CLOSE_MS)
                relays.values.forEach { it.closeAll() }
            }
        } else {
            relays.values.forEach { it.resumeIfNeeded() }
        }
    }

    private fun relay(url: String): Relay = relays.getOrPut(normalize(url)) { Relay(normalize(url)) }

    // ── Subscriptions ───────────────────────────────────────────────────────

    sealed interface Message {
        data class Event(val relay: String, val event: NostrEvent) : Message
        data class Eose(val relay: String) : Message
        data class Closed(val relay: String, val reason: String) : Message
    }

    /** A live subscription across [urls]; cancelled by cancelling the collector. */
    fun subscribe(urls: Collection<String>, filters: List<Filter>): Flow<Message> = callbackFlow {
        val id = "n" + subIds.incrementAndGet().toString(36)
        val seen = HashSet<String>()
        val targets = urls.map(::normalize).distinct().map(::relay)
        val handler = object : SubHandler {
            override fun onEvent(relay: String, event: NostrEvent) {
                synchronized(seen) { if (!seen.add(event.id)) return }
                trySend(Message.Event(relay, event))
            }
            override fun onEose(relay: String) { trySend(Message.Eose(relay)) }
            override fun onClosed(relay: String, reason: String) { trySend(Message.Closed(relay, reason)) }
        }
        targets.forEach { it.addSub(id, filters, handler) }
        awaitClose { targets.forEach { it.removeSub(id) } }
    }

    /**
     * One-shot fetch (nostr/stream.ts semantics): settles [graceMs] after the
     * first EOSE, or when every reachable relay has answered, or at [timeoutMs].
     * [answered] tells "none exist" apart from "nobody replied".
     */
    suspend fun fetch(urls: Collection<String>, filters: List<Filter>, timeoutMs: Long = 8_000, graceMs: Long = 600): FetchResult {
        val events = LinkedHashMap<String, NostrEvent>()
        val eosed = HashSet<String>()
        val targets = urls.map(::normalize).distinct()
        if (targets.isEmpty()) return FetchResult(emptyList(), 0)
        withTimeoutOrNull(timeoutMs) {
            var firstEose = -1L
            // A ticker interleaved with relay messages, so the grace period ends on
            // time even when nothing else arrives.
            merge<Any>(subscribe(targets, filters), ticker()).transformWhile { m ->
                when (m) {
                    is Message.Event -> events[m.event.id] = m.event
                    is Message.Eose -> eosed += m.relay
                    is Message.Closed -> eosed += m.relay
                    else -> Unit
                }
                if (firstEose < 0 && eosed.isNotEmpty()) firstEose = System.currentTimeMillis()
                val dead = targets.count { relay(it).isDead && it !in eosed }
                val allAnswered = eosed.size + dead >= targets.size
                val graceOver = firstEose > 0 && System.currentTimeMillis() - firstEose > graceMs
                emit(Unit)
                !(allAnswered || graceOver)
            }.collect()
        }
        return FetchResult(events.values.toList(), eosed.size)
    }

    private object Tick

    private fun ticker(): Flow<Any> = flow { while (true) { delay(150); emit(Tick) } }

    data class FetchResult(val events: List<NostrEvent>, val answered: Int)

    // ── Publishing ──────────────────────────────────────────────────────────

    sealed interface PublishOutcome {
        data object Ok : PublishOutcome
        data class Rejected(val reason: String) : PublishOutcome
        data object Timeout : PublishOutcome
    }

    /** Publish to every relay in [urls], waiting at most [timeoutMs] for each OK. */
    suspend fun publish(event: NostrEvent, urls: Collection<String>, timeoutMs: Long = PUBLISH_TIMEOUT_MS): Map<String, PublishOutcome> {
        val targets = urls.map(::normalize).distinct()
        val waits = targets.associateWith { relay(it).publish(event) }
        return waits.mapValues { (_, d) -> withTimeoutOrNull(timeoutMs) { d.await() } ?: PublishOutcome.Timeout }
    }

    // ── One relay ───────────────────────────────────────────────────────────

    private interface SubHandler {
        fun onEvent(relay: String, event: NostrEvent)
        fun onEose(relay: String)
        fun onClosed(relay: String, reason: String)
    }

    private inner class Relay(val url: String) {
        private var socket: WebSocket? = null
        @Volatile private var connected = false
        private var connecting = false
        private var failures = 0
        private var reconnectJob: Job? = null
        private var idleJob: Job? = null
        private val subs = ConcurrentHashMap<String, Pair<List<Filter>, SubHandler>>()
        private val pendingOk = ConcurrentHashMap<String, CompletableDeferred<PublishOutcome>>()
        private val queue = ArrayDeque<String>()

        /** Gave up for now: several failures in a row. Fetches don't wait on it. */
        val isDead: Boolean get() = !connected && failures >= 2

        @Synchronized fun addSub(id: String, filters: List<Filter>, h: SubHandler) {
            subs[id] = filters to h
            idleJob?.cancel()
            send(req(id, filters))
        }

        @Synchronized fun removeSub(id: String) {
            if (subs.remove(id) != null && connected) socket?.send("""["CLOSE",${JsJson.quote(id)}]""")
            scheduleIdleClose()
        }

        @Synchronized fun publish(event: NostrEvent): CompletableDeferred<PublishOutcome> {
            val d = CompletableDeferred<PublishOutcome>()
            pendingOk[event.id]?.let { return it }
            pendingOk[event.id] = d
            idleJob?.cancel()
            send("""["EVENT",${event.toJsonString()}]""")
            scope.launch { delay(PUBLISH_TIMEOUT_MS * 4); pendingOk.remove(event.id)?.complete(PublishOutcome.Timeout) }
            return d
        }

        private fun req(id: String, filters: List<Filter>) =
            buildString { append("[\"REQ\",").append(JsJson.quote(id)); filters.forEach { append(',').append(it.toJson()) }; append(']') }

        private fun send(frame: String) {
            if (connected) socket?.send(frame) else {
                queue.addLast(frame)
                connect()
            }
        }

        @Synchronized fun resumeIfNeeded() {
            if (subs.isNotEmpty() && !connected) connect()
        }

        @Synchronized fun connect() {
            if (connected || connecting || !foreground) return
            connecting = true
            reconnectJob?.cancel()
            socket = http.newWebSocket(Request.Builder().url(url).build(), Listener())
        }

        @Synchronized fun closeAll() {
            reconnectJob?.cancel()
            socket?.close(1000, null)
            socket = null
            connected = false
            connecting = false
            queue.clear()
        }

        private fun scheduleIdleClose() {
            if (subs.isNotEmpty() || pendingOk.isNotEmpty()) return
            idleJob?.cancel()
            idleJob = scope.launch {
                delay(IDLE_CLOSE_MS)
                synchronized(this@Relay) { if (subs.isEmpty() && pendingOk.isEmpty()) closeAll() }
            }
        }

        private inner class Listener : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(this@Relay) {
                    if (webSocket !== socket) return
                    connected = true
                    connecting = false
                    failures = 0
                    // Re-issue every live subscription, then flush queued frames
                    // (REQs among them are now duplicates and are skipped).
                    val reqs = subs.map { (id, v) -> req(id, v.first) }
                    reqs.forEach { webSocket.send(it) }
                    while (queue.isNotEmpty()) {
                        val f = queue.removeFirst()
                        if (!f.startsWith("[\"REQ\"")) webSocket.send(f)
                    }
                }
                updateOnline()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val arr = runCatching { json.parseToJsonElement(text) as JsonArray }.getOrNull() ?: return
                val type = (arr.getOrNull(0) as? JsonPrimitive)?.content ?: return
                when (type) {
                    "EVENT" -> {
                        val id = (arr.getOrNull(1) as? JsonPrimitive)?.content ?: return
                        val ev = arr.getOrNull(2)?.let(NostrEvent::fromJson) ?: return
                        // Never trust a relay: verify the id and signature of every event.
                        if (!ev.verify()) return
                        subs[id]?.second?.onEvent(url, ev)
                    }
                    "EOSE" -> (arr.getOrNull(1) as? JsonPrimitive)?.content?.let { subs[it]?.second?.onEose(url) }
                    "CLOSED" -> {
                        val id = (arr.getOrNull(1) as? JsonPrimitive)?.content ?: return
                        subs[id]?.second?.onClosed(url, (arr.getOrNull(2) as? JsonPrimitive)?.content ?: "")
                    }
                    "OK" -> {
                        val id = (arr.getOrNull(1) as? JsonPrimitive)?.content ?: return
                        val ok = (arr.getOrNull(2) as? JsonPrimitive)?.booleanOrNull ?: false
                        val msg = (arr.getOrNull(3) as? JsonPrimitive)?.content ?: ""
                        // "duplicate:" means the relay already has it — that is success.
                        val outcome = if (ok || msg.startsWith("duplicate")) PublishOutcome.Ok else PublishOutcome.Rejected(msg)
                        pendingOk.remove(id)?.complete(outcome)
                        synchronized(this@Relay) { scheduleIdleClose() }
                    }
                    "NOTICE" -> Log.d(TAG, "$url NOTICE ${arr.getOrNull(1)}")
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, null)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket, t)

            private fun dropped(webSocket: WebSocket, t: Throwable?) {
                synchronized(this@Relay) {
                    if (webSocket !== socket) return
                    connected = false
                    connecting = false
                    socket = null
                    failures++
                    if (t != null) Log.d(TAG, "$url failed: ${t.message}")
                    // Fail every subscription's wait for EOSE on this relay, so fetches settle.
                    subs.values.forEach { it.second.onClosed(url, "connection lost") }
                    if (failures >= 2) pendingOk.values.forEach { it.complete(PublishOutcome.Rejected("unreachable")) }
                    if (failures >= 2) pendingOk.clear()
                    if (subs.isNotEmpty() && foreground) {
                        val backoff = minOf(60_000L, 1_000L shl minOf(failures, 6))
                        reconnectJob = scope.launch { delay(backoff); connect() }
                    }
                }
                updateOnline()
            }
        }
    }

    private fun updateOnline() {
        val any = relays.values.any { it.isDeadOrUp() }
        _online.value = any
    }

    private fun Relay.isDeadOrUp(): Boolean = !isDead

    companion object {
        private const val TAG = "RelayPool"
        const val IDLE_CLOSE_MS = 45_000L
        const val BACKGROUND_CLOSE_MS = 30_000L
        const val PUBLISH_TIMEOUT_MS = 5_000L
        private val json = Json { ignoreUnknownKeys = true }

        fun normalize(url: String): String {
            var u = url.trim()
            if (u.endsWith("/")) u = u.dropLast(1)
            return u.lowercase().let { if (it.startsWith("wss://") || it.startsWith("ws://")) it else "wss://$it" }
        }

        fun newHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .build()
    }
}

/** A NIP-01 filter. Built with named fields, serialized to the JSON relays expect. */
data class Filter(
    val ids: List<String>? = null,
    val authors: List<String>? = null,
    val kinds: List<Int>? = null,
    val tags: Map<String, List<String>> = emptyMap(),
    val since: Long? = null,
    val until: Long? = null,
    val limit: Int? = null,
) {
    fun toJson(): String {
        val m = LinkedHashMap<String, JsonElement>()
        ids?.let { m["ids"] = JsonArray(it.map(::JsonPrimitive)) }
        authors?.let { m["authors"] = JsonArray(it.map(::JsonPrimitive)) }
        kinds?.let { m["kinds"] = JsonArray(it.map(::JsonPrimitive)) }
        tags.forEach { (k, v) -> m["#$k"] = JsonArray(v.map(::JsonPrimitive)) }
        since?.let { m["since"] = JsonPrimitive(it) }
        until?.let { m["until"] = JsonPrimitive(it) }
        limit?.let { m["limit"] = JsonPrimitive(it) }
        return JsJson.stringify(JsonObject(m))
    }

    /** Does a stored event satisfy this filter? (For answering from the local store.) */
    fun matches(e: NostrEvent): Boolean {
        if (ids != null && e.id !in ids) return false
        if (authors != null && e.pubkey !in authors) return false
        if (kinds != null && e.kind !in kinds) return false
        if (since != null && e.createdAt < since) return false
        if (until != null && e.createdAt > until) return false
        for ((k, v) in tags) if (e.tags.none { it.size >= 2 && it[0] == k && it[1] in v }) return false
        return true
    }
}
