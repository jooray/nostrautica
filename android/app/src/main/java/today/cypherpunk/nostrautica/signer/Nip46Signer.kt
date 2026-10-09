package today.cypherpunk.nostrautica.signer

import android.net.Uri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.isHex32
import today.cypherpunk.nostrautica.protocol.nowSec

/**
 * NIP-46 remote signing (signer/nip46.ts): JSON-RPC in NIP-44-encrypted kind
 * 24133 events between an app-held client key and the user's bunker.
 *
 * The relays are always ours ([Relays.NIP46] ∪ the pointer's), and a signer's
 * `switch_relays` is ignored: replies are ephemeral, so they only land if a socket
 * we share with the signer is open at that moment, and narrowing the set to one
 * relay the signer prefers (Amber's default still names a dead one) strands the
 * session.
 */
class Nip46Signer private constructor(
    private val pool: RelayPool,
    val session: Session,
) : NostrSigner {
    @Serializable
    data class Session(val clientSk: String, val signerPubkey: String, val userPubkey: String, val relays: List<String>, val secret: String? = null)

    override val pubkey: String get() = session.userPubkey
    override val isLocal = false

    private val client = LocalSigner(Bytes.fromHex(session.clientSk))
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = HashMap<String, CompletableDeferred<JsonObject>>()
    private val pendingLock = Mutex()
    private var listener: Job? = null

    private val _authUrls = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** A bunker asking the user to approve in a browser (NIP-46 `auth_url`). */
    val authUrls: SharedFlow<String> get() = _authUrls

    private fun ensureListening() {
        if (listener?.isActive == true) return
        listener = scope.launch {
            pool.subscribe(session.relays, listOf(Filter(kinds = listOf(Kinds.NIP46), tags = mapOf("p" to listOf(client.pubkey)), since = nowSec() - 10)))
                .filterIsInstance<RelayPool.Message.Event>()
                .collect { m -> handle(m.event) }
        }
    }

    private suspend fun handle(e: NostrEvent) {
        if (e.pubkey != session.signerPubkey) return
        val text = runCatching { client.nip44Decrypt(e.pubkey, e.content) }.getOrNull() ?: return
        val msg = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return
        val id = (msg["id"] as? JsonPrimitive)?.content ?: return
        val result = (msg["result"] as? JsonPrimitive)?.content
        if (result == "auth_url") {
            (msg["error"] as? JsonPrimitive)?.content?.let { _authUrls.tryEmit(it) }
            return
        }
        pendingLock.withLock { pending.remove(id) }?.complete(msg)
    }

    private suspend fun call(method: String, params: List<String>, timeoutMs: Long = REQUEST_TIMEOUT_MS): String {
        if (isSilent() && method != "get_public_key") {
            // A remote round trip may wake the user's phone; background work never asks.
            throw SignerNeedsUser()
        }
        ensureListening()
        val id = Bytes.toHex(Bytes.random(8))
        val d = CompletableDeferred<JsonObject>()
        pendingLock.withLock { pending[id] = d }
        val body = JsJson.stringify(buildJsonObject {
            put("id", id); put("method", method); put("params", JsonArray(params.map(::JsonPrimitive)))
        })
        val ev = client.signNow(client.template(Kinds.NIP46, client.nip44Encrypt(session.signerPubkey, body), listOf(listOf("p", session.signerPubkey))))
        pool.publish(ev, session.relays)
        val reply = try {
            withTimeout(timeoutMs) { d.await() }
        } finally {
            pendingLock.withLock { pending.remove(id) }
        }
        (reply["error"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }?.let { throw SignerRejected(it) }
        return reply["result"]?.jsonPrimitive?.content ?: throw SignerRejected("empty reply")
    }

    override suspend fun sign(event: UnsignedEvent): NostrEvent {
        val out = call("sign_event", listOf(JsJson.stringify(buildJsonObject {
            put("kind", event.kind); put("content", event.content); put("tags", today.cypherpunk.nostrautica.protocol.tagsToJson(event.tags))
            put("created_at", event.createdAt); put("pubkey", event.pubkey)
        })))
        val signed = NostrEvent.fromJsonString(out) ?: throw SignerRejected("unreadable signed event")
        if (signed.id != event.id || !signed.verify()) throw SignerRejected("the signer returned a different or invalid event")
        return signed
    }

    override suspend fun nip44Encrypt(peerPubkey: String, plaintext: String) = call("nip44_encrypt", listOf(peerPubkey, plaintext))

    override suspend fun nip44Decrypt(peerPubkey: String, ciphertext: String): String {
        if (!Nip44.isCiphertext(ciphertext)) throw IllegalArgumentException("not a NIP-44 payload")
        return call("nip44_decrypt", listOf(peerPubkey, ciphertext))
    }

    /** Cheap liveness probe after a restore. */
    suspend fun ping(): Boolean = runCatching { call("ping", emptyList(), RESTORE_TIMEOUT_MS) }.isSuccess

    fun close() { listener?.cancel(); scope.coroutineContext[Job]?.cancel() }

    companion object {
        const val REQUEST_TIMEOUT_MS = 60_000L
        const val CONNECT_TIMEOUT_MS = 45_000L
        const val NOSTRCONNECT_TIMEOUT_MS = 120_000L
        const val RESTORE_TIMEOUT_MS = 12_000L

        fun restore(pool: RelayPool, session: Session) = Nip46Signer(pool, session)

        private fun relaysWith(extra: List<String>) = (Relays.NIP46 + extra).map(RelayPool::normalize).distinct()

        /** A `nostrconnect://` offer: show it as a QR code or hand it to a signer app. */
        class Offer(val uri: String, val clientSk: String, val secret: String, val relays: List<String>)

        fun nostrConnectOffer(): Offer {
            val sk = Bytes.toHex(today.cypherpunk.nostrautica.protocol.Secp.generateSecret())
            val clientPub = LocalSigner(Bytes.fromHex(sk)).pubkey
            val secret = Bytes.toHex(Bytes.random(16))
            val relays = relaysWith(emptyList())
            val uri = buildString {
                append("nostrconnect://").append(clientPub).append('?')
                append(relays.joinToString("&") { "relay=" + Uri.encode(it) })
                append("&secret=").append(secret)
                append("&perms=").append(Uri.encode(SignerPermissions.NIP46))
                append("&name=").append(Uri.encode("Nostrautica"))
                append("&url=").append(Uri.encode("https://nostrautica.cypherpunk.today"))
            }
            return Offer(uri, sk, secret, relays)
        }

        /** Wait for the signer to answer a [nostrConnectOffer]. */
        suspend fun awaitNostrConnect(pool: RelayPool, offer: Offer): Nip46Signer {
            val client = LocalSigner(Bytes.fromHex(offer.clientSk))
            val signerPubkey = withTimeout(NOSTRCONNECT_TIMEOUT_MS) {
                val found = CompletableDeferred<String>()
                val job = CoroutineScope(Dispatchers.IO).launch {
                    pool.subscribe(offer.relays, listOf(Filter(kinds = listOf(Kinds.NIP46), tags = mapOf("p" to listOf(client.pubkey)), since = nowSec() - 30)))
                        .filterIsInstance<RelayPool.Message.Event>()
                        .collect { m ->
                            val text = runCatching { client.nip44Decrypt(m.event.pubkey, m.event.content) }.getOrNull() ?: return@collect
                            val msg = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return@collect
                            val result = (msg["result"] as? JsonPrimitive)?.content
                            if (result == offer.secret || result == "ack") found.complete(m.event.pubkey)
                        }
                }
                try { found.await() } finally { job.cancel() }
            }
            val probe = Nip46Signer(pool, Session(offer.clientSk, signerPubkey, signerPubkey, offer.relays, offer.secret))
            val user = probe.call("get_public_key", emptyList(), CONNECT_TIMEOUT_MS).trim()
            require(user.isHex32()) { "the signer returned an unreadable key" }
            probe.close()
            return Nip46Signer(pool, Session(offer.clientSk, signerPubkey, user, offer.relays, offer.secret))
        }

        /** Connect from a pasted `bunker://<pubkey>?relay=…&secret=…`. */
        suspend fun connectBunker(pool: RelayPool, bunkerUri: String): Nip46Signer {
            val uri = Uri.parse(bunkerUri.trim())
            require(uri.scheme == "bunker") { "not a bunker:// link" }
            val signerPubkey = uri.host?.lowercase()?.takeIf { it.isHex32() } ?: throw IllegalArgumentException("the bunker link has no signer key")
            val relays = relaysWith(uri.getQueryParameters("relay").filter { it.startsWith("wss://") || it.startsWith("ws://") })
            val secret = uri.getQueryParameter("secret")
            val sk = Bytes.toHex(today.cypherpunk.nostrautica.protocol.Secp.generateSecret())
            val probe = Nip46Signer(pool, Session(sk, signerPubkey, signerPubkey, relays, secret))
            probe.call("connect", listOfNotNull(signerPubkey, secret ?: "", SignerPermissions.NIP46), CONNECT_TIMEOUT_MS)
            val user = probe.call("get_public_key", emptyList(), CONNECT_TIMEOUT_MS).trim()
            require(user.isHex32()) { "the signer returned an unreadable key" }
            probe.close()
            return Nip46Signer(pool, Session(sk, signerPubkey, user, relays, secret))
        }
    }
}
