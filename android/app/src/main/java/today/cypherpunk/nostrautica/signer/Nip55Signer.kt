package today.cypherpunk.nostrautica.signer

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.withResumed
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.isHex64

/**
 * NIP-55: a signer app on this phone (Amber and others).
 *
 * Every request goes to the signer's content provider first: once the user has
 * allowed a kind or NIP-44 for this app, it answers in the background with no UI.
 * Only when it declines does the app open the signer's activity — and only after
 * our own activity is RESUMED, because signer activities are singleTask and an
 * intent that reaches a still-closing signer window comes back as an instant
 * RESULT_CANCELED (the lesson the shared nostr-signin module learned at login).
 * An instant cancel with no data is retried once.
 */
class Nip55Signer(
    private val context: Context,
    override val pubkey: String,
    val signerPackage: String,
    private val bridge: SignerIntentBridge,
) : NostrSigner {
    override val isLocal = false
    private val npub = Nip19.npub(pubkey)
    /** One signer request at a time: Amber handles one activity at a time. */
    private val lock = Mutex()

    override suspend fun sign(event: UnsignedEvent): NostrEvent {
        require(event.pubkey == pubkey) { "event pubkey does not match the signer" }
        val eventJson = JsJson.stringify(event.toRumorJson())
        val sig = request("SIGN_EVENT", "sign_event", eventJson, extra = mapOf("id" to event.id)) { cols ->
            cols("event")?.let { signatureFromEvent(it, event) } ?: cols("result")?.takeIf { it.isHex64() } ?: cols("signature")?.takeIf { it.isHex64() }
        }
        val signed = NostrEvent(event.id, event.pubkey, event.createdAt, event.kind, event.tags, event.content, sig.lowercase())
        if (!signed.verify()) throw SignerRejected("the signer returned an invalid signature")
        return signed
    }

    override suspend fun nip44Encrypt(peerPubkey: String, plaintext: String): String =
        request("NIP44_ENCRYPT", "nip44_encrypt", plaintext, peer = peerPubkey) { it("result") }

    override suspend fun nip44Decrypt(peerPubkey: String, ciphertext: String): String =
        request("NIP44_DECRYPT", "nip44_decrypt", ciphertext, peer = peerPubkey) { it("result") }

    private suspend fun request(
        provider: String,
        type: String,
        payload: String,
        peer: String? = null,
        extra: Map<String, String> = emptyMap(),
        read: ((String) -> String?) -> String?,
    ): String = lock.withLock {
        // 1. The content provider: silent when the user allowed it.
        val silent = withContext(Dispatchers.IO) { viaProvider(provider, payload, peer, read) }
        when (silent) {
            is ProviderReply.Ok -> return@withLock silent.value
            ProviderReply.Rejected, ProviderReply.Unavailable -> Unit
        }
        if (isSilent()) throw SignerNeedsUser()
        // 2. The signer's activity, once we are in front.
        var attempt = 0
        while (true) {
            val started = SystemClock.elapsedRealtime()
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:$payload")).apply {
                setPackage(signerPackage)
                putExtra("type", type)
                putExtra("current_user", npub)
                peer?.let { putExtra("pubkey", it) }
                extra.forEach { (k, v) -> putExtra(k, v) }
            }
            val result = bridge.launch(intent)
            val data = result.data
            if (result.resultCode == Activity.RESULT_OK && data != null) {
                return@withLock read { data.getStringExtra(it) } ?: throw SignerRejected("the signer answered with nothing usable")
            }
            val instant = SystemClock.elapsedRealtime() - started < 1_000 && data == null
            if (instant && attempt++ == 0) { delay(400); continue }
            throw SignerRejected()
        }
        @Suppress("UNREACHABLE_CODE") error("unreachable")
    }

    private sealed interface ProviderReply {
        data class Ok(val value: String) : ProviderReply
        data object Rejected : ProviderReply
        data object Unavailable : ProviderReply
    }

    private fun viaProvider(provider: String, payload: String, peer: String?, read: ((String) -> String?) -> String?): ProviderReply {
        val uri = Uri.parse("content://$signerPackage.$provider")
        val cursor = try {
            context.contentResolver.query(uri, arrayOf(payload, peer ?: "", npub), null, null, null)
        } catch (e: SecurityException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        } ?: return ProviderReply.Unavailable
        return cursor.use { c ->
            if (c.getColumnIndex("rejected") >= 0) return@use ProviderReply.Rejected
            if (!c.moveToFirst()) return@use ProviderReply.Unavailable
            val value = read { key -> c.getColumnIndex(key).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getString(it) } }
            if (value != null) ProviderReply.Ok(value) else ProviderReply.Unavailable
        }
    }

    /** Accept a returned event only if it is the one we asked for (a signer may restamp created_at). */
    private fun signatureFromEvent(json: String, expected: UnsignedEvent): String? {
        val e = NostrEvent.fromJsonString(json) ?: return null
        if (e.pubkey != expected.pubkey || e.kind != expected.kind || e.createdAt != expected.createdAt || e.id != expected.id) return null
        return e.sig.takeIf { it.isHex64() }
    }

    companion object {
        data class SignerApp(val packageName: String, val label: String)

        fun installedSigners(context: Context): List<SignerApp> {
            val pm = context.packageManager
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"))
            val infos = if (Build.VERSION.SDK_INT >= 33) pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
            else @Suppress("DEPRECATION") pm.queryIntentActivities(intent, 0)
            return infos.map { SignerApp(it.activityInfo.packageName, it.loadLabel(pm).toString()) }.distinctBy { it.packageName }
        }

        /** `get_public_key`, asking up front for everything the app will need. */
        suspend fun connect(bridge: SignerIntentBridge, signerPackage: String): Pair<String, String> {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
                setPackage(signerPackage)
                putExtra("type", "get_public_key")
                putExtra("permissions", SignerPermissions.NIP55_JSON)
            }
            val result = bridge.launch(intent)
            val data = result.data
            if (result.resultCode != Activity.RESULT_OK || data == null) throw SignerRejected()
            val raw = data.getStringExtra("result")?.trim() ?: throw SignerRejected("the signer returned no key")
            val pubkey = Nip19.pubkeyFrom(raw) ?: throw SignerRejected("the signer returned an unreadable key")
            val pkg = data.getStringExtra("package")?.takeIf { it.isNotBlank() } ?: signerPackage
            return pubkey to pkg
        }
    }
}

/**
 * Carries signer intents to the activity. One per app; [SignerBridgeHost] sits in
 * the root composition and launches them only when we are resumed.
 */
class SignerIntentBridge {
    internal class Req(val intent: Intent, val result: CompletableDeferred<ActivityResult>)

    internal val requests = Channel<Req>(Channel.UNLIMITED)
    @Volatile internal var inFlight: Req? = null

    suspend fun launch(intent: Intent): ActivityResult {
        val r = Req(intent, CompletableDeferred())
        requests.send(r)
        return r.result.await()
    }
}

@Composable
fun SignerBridgeHost(bridge: SignerIntentBridge) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        bridge.inFlight?.let { bridge.inFlight = null; it.result.complete(result) }
    }
    LaunchedEffect(bridge) {
        bridge.inFlight?.result?.let { runCatching { it.await() } }
        for (req in bridge.requests) {
            lifecycle.withResumed { }
            bridge.inFlight = req
            try {
                launcher.launch(req.intent)
            } catch (e: ActivityNotFoundException) {
                bridge.inFlight = null
                req.result.completeExceptionally(SignerUnavailable("the signer app is not installed"))
                continue
            }
            runCatching { req.result.await() }
        }
    }
}
