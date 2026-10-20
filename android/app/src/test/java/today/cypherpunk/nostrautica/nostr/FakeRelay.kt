package today.cypherpunk.nostrautica.nostr

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.NostrEvent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A scriptable NIP-01 relay on a local MockWebServer, for tests of the transport
 * and of anything built on it. By default it answers a REQ with [events] then
 * EOSE, and an EVENT with OK true.
 */
class FakeRelay : AutoCloseable {
    private val server = MockWebServer()
    val events = CopyOnWriteArrayList<NostrEvent>()
    val received = CopyOnWriteArrayList<NostrEvent>()

    /** Called for each REQ; the default sends [events] and EOSE. */
    @Volatile var onReq: (ws: WebSocket, sub: String, filters: List<JsonObject>) -> Unit = { ws, sub, _ ->
        events.forEach { ws.send("""["EVENT",${JsJson.quote(sub)},${it.toJsonString()}]""") }
        ws.send("""["EOSE",${JsJson.quote(sub)}]""")
    }

    /** Called for each EVENT; the default accepts it. */
    @Volatile var onEvent: (ws: WebSocket, event: NostrEvent) -> Unit = { ws, e -> ws.send("""["OK","${e.id}",true,""]""") }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val arr = Json.parseToJsonElement(text) as JsonArray
                        when ((arr[0] as JsonPrimitive).content) {
                            "REQ" -> onReq(webSocket, (arr[1] as JsonPrimitive).content, arr.drop(2).map { it as JsonObject })
                            "EVENT" -> NostrEvent.fromJson(arr[1])?.let { received += it; onEvent(webSocket, it) }
                        }
                    }
                }).build()
        }
        server.start()
    }

    val url: String get() = "ws://${server.hostName}:${server.port}"

    override fun close() = server.close()
}
