package today.cypherpunk.nostrautica.signer

import android.net.Uri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
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

    /** Requests a bunker answered with `auth_url`: they get [AUTH_APPROVAL_TIMEOUT_MS] more to settle. */
    private val awaitingApproval = HashSet<String>()

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
            // Not the reply: the real one follows on the same id once the user approves.
            // Only for a request still waiting, so a late challenge can't resurrect the banner.
            val url = (msg["error"] as? JsonPrimitive)?.content?.let(Nip46Approvals::safeAuthUrl) ?: return
            pendingLock.withLock {
                if (id !in pending) return
                awaitingApproval += id
                Nip46Approvals.open(id, url) // under the lock, so it can't land after call()'s settle
            }
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
        val reply = try {
            val sent = pool.publish(ev, session.relays)
            // Every signer relay refused or was unreachable: nothing can answer, so
            // don't sit out the whole timeout.
            if (sent.isNotEmpty() && sent.values.all { it is RelayPool.PublishOutcome.Rejected }) {
                throw SignerUnavailable("no signer relay is reachable")
            }
            // withTimeoutOrNull, not withTimeout: a TimeoutCancellationException is a
            // CancellationException, which callers treat as "the user left" and
            // swallow (or rethrow, ending an enclosing scan).
            withTimeoutOrNull(timeoutMs) { d.await() }
                // Approving in a browser takes longer than a signer app's tap.
                ?: (if (pendingLock.withLock { id in awaitingApproval }) withTimeoutOrNull(AUTH_APPROVAL_TIMEOUT_MS) { d.await() } else null)
                ?: throw SignerUnavailable("the signer did not answer")
        } finally {
            pendingLock.withLock { pending.remove(id); awaitingApproval.remove(id) }
            Nip46Approvals.settle(id)
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

    /** Who the bunker signs for right now (a bounded get_public_key), for the identity check after a restore. */
    suspend fun remotePubkey(): String = call("get_public_key", emptyList(), RESTORE_TIMEOUT_MS).trim().lowercase()

    fun close() { listener?.cancel(); scope.coroutineContext[Job]?.cancel() }

    companion object {
        const val REQUEST_TIMEOUT_MS = 60_000L
        const val CONNECT_TIMEOUT_MS = 45_000L
        const val NOSTRCONNECT_TIMEOUT_MS = 120_000L
        const val RESTORE_TIMEOUT_MS = 12_000L
        const val AUTH_APPROVAL_TIMEOUT_MS = 180_000L

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

        /**
         * Does this decrypted reply complete a `nostrconnect://` handshake? Only one
         * that echoes the offer's secret: the client pubkey is public (it is in the QR
         * and in the REQ every relay sees), so anyone can encrypt a reply to it, and
         * the secret is the one proof the responder actually saw the code. A bare
         * `"ack"` proves nothing and would let a relay peer become the user's signer.
         * Same rule as nostr-tools (`response.result === secret`), which the PWA uses.
         */
        internal fun acceptsNostrConnect(msg: JsonObject, secret: String): Boolean {
            val result = msg["result"] as? JsonPrimitive ?: return false
            return result.isString && secret.isNotEmpty() && result.content == secret
        }

        /** Wait for the signer to answer a [nostrConnectOffer]. */
        suspend fun awaitNostrConnect(pool: RelayPool, offer: Offer): Nip46Signer {
            val client = LocalSigner(Bytes.fromHex(offer.clientSk))
            val signerPubkey = withTimeoutOrNull(NOSTRCONNECT_TIMEOUT_MS) {
                val found = CompletableDeferred<String>()
                val job = CoroutineScope(Dispatchers.IO).launch {
                    pool.subscribe(offer.relays, listOf(Filter(kinds = listOf(Kinds.NIP46), tags = mapOf("p" to listOf(client.pubkey)), since = nowSec() - 30)))
                        .filterIsInstance<RelayPool.Message.Event>()
                        .collect { m ->
                            val text = runCatching { client.nip44Decrypt(m.event.pubkey, m.event.content) }.getOrNull() ?: return@collect
                            val msg = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return@collect
                            if (acceptsNostrConnect(msg, offer.secret)) found.complete(m.event.pubkey)
                        }
                }
                try { found.await() } finally { job.cancel() }
            } ?: throw SignerUnavailable("the signer did not answer; show a fresh code and try again")
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
