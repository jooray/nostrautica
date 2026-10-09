package today.cypherpunk.nostrautica.domain.chat

import android.content.Context
import android.os.Build
import android.util.Log
import dev.ipf.marmotkit.AccountSetupReadinessFfi
import dev.ipf.marmotkit.Marmot
import dev.ipf.marmotkit.MarmotAndroid
import dev.ipf.marmotkit.MarmotEventFfi
import dev.ipf.marmotkit.MarmotKitException
import dev.ipf.marmotkit.MarmotOptions
import dev.ipf.marmotkit.RelayPolicyFfi
import dev.ipf.marmotkit.SecretStore
import dev.ipf.marmotkit.SelfMembershipFfi
import dev.ipf.marmotkit.SendAcceptDispositionFfi
import dev.ipf.marmotkit.TimelineMessageRecordFfi
import dev.ipf.marmotkit.TimelineMessagesSubscription
import dev.ipf.marmotkit.TimelinePageFfi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Nip19
import java.io.File

/**
 * [ChatEngine] over MDK's MarmotKit (native MLS).
 *
 * Battery and size: the runtime exists only while something holds it. The chat
 * screen [acquire]s it when it becomes visible and [release]s it when it goes
 * away (or the app goes to the background); after a short grace period with no
 * holder it is `shutdownAndClose()`d, which closes storage, drops the relay
 * sockets and releases the root lock. There is no background service. The native
 * library (~46 MB) is loaded only on first chat use, never at app start.
 *
 * Account secrets go to the app's Keystore-sealed SecureStore through MDK's
 * [SecretStore] callback, next to the device key they were imported from.
 *
 * Every MarmotKit call runs on [Dispatchers.IO]: several are synchronous SQLCipher
 * reads that must never run on the main thread.
 */
class MarmotEngine(private val context: Context, private val kv: SecretKv, private val bootstrapRelays: List<String>) : ChatEngine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private var marmot: Marmot? = null
    private var refs = 0
    private var closeJob: Job? = null
    private var eventsJob: Job? = null
    private val events = MutableSharedFlow<String>(extraBufferCapacity = 64)

    /** Hold the runtime open. Pair every call with [release]. */
    override suspend fun acquire() {
        withContext(Dispatchers.IO) {
            lock.withLock {
                closeJob?.cancel(); closeJob = null
                refs++
                if (marmot == null) marmot = open()
            }
        }
    }

    override fun release() {
        scope.launch {
            lock.withLock {
                refs = maxOf(0, refs - 1)
                if (refs == 0 && closeJob?.isActive != true) {
                    closeJob = scope.launch {
                        delay(GRACE_MS)
                        lock.withLock { if (refs == 0) close(); closeJob = null }
                    }
                }
            }
        }
    }

    private suspend fun open(): Marmot {
        if (!nativeReady) {
            MarmotAndroid.initialize(context.applicationContext)
            nativeReady = true
        }
        val root = File(context.noBackupFilesDir, "marmot").apply { mkdirs() }
        val options = MarmotOptions(
            clientName = CLIENT_NAME,
            secretStore = KvSecretStore(kv),
            // Plain ws:// only exists in debug builds pointed at the local test
            // stack (-PdevRelays=ws://127.0.0.1:7777 via `adb reverse`); MDK accepts
            // it for loopback alone, and only when asked. Real builds stay public-only.
            relayPolicy = if (today.cypherpunk.nostrautica.BuildConfig.DEV_RELAYS.isNotEmpty()) RelayPolicyFfi.ALLOW_LOOPBACK_RELAYS_AND_BLOBS else null,
        )
        var attempt = 0
        val m = run {
            while (true) {
                try {
                    return@run Marmot.newWithConfiguration(root.path, bootstrapRelays, options)
                } catch (e: MarmotKitException.RuntimeBusy) {
                    // A previous runtime of this process is still closing its root.
                    if (++attempt > 20) throw e
                    delay(250)
                }
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }
        m.start()
        eventsJob = scope.launch {
            val sub = m.subscribeEvents()
            try {
                while (isActive) {
                    val e = sub.next() ?: break
                    labelOf(e)?.let { events.tryEmit(it) }
                }
            } catch (e: Exception) {
                Log.w(TAG, "event stream ended: ${e.javaClass.simpleName}")
            } finally {
                runCatching { sub.close() }
            }
        }
        return m
    }

    private suspend fun close() {
        val m = marmot ?: return
        marmot = null
        eventsJob?.cancel(); eventsJob = null
        withContext(NonCancellable) {
            runCatching { m.shutdownAndClose() }.onFailure { Log.w(TAG, "shutdown: ${it.javaClass.simpleName}") }
            runCatching { m.close() }
        }
    }

    private fun labelOf(e: MarmotEventFfi): String? = when (e) {
        is MarmotEventFfi.GroupJoined -> e.accountLabel
        is MarmotEventFfi.GroupStateUpdated -> e.accountLabel
        is MarmotEventFfi.GroupEvent -> e.accountLabel
        is MarmotEventFfi.MessageReceived -> e.received.accountLabel
        is MarmotEventFfi.WelcomeDeliveryPending -> e.accountLabel
        is MarmotEventFfi.EpochStallEscalated -> e.accountLabel
        else -> null
    }

    private fun m(): Marmot = marmot ?: throw IllegalStateException("chat engine is closed")

    private suspend fun <T> io(block: suspend Marmot.() -> T): T = withContext(Dispatchers.IO) { m().block() }

    override suspend fun createDeviceIdentity(relays: List<String>, bootstrap: List<String>): ByteArray = io {
        val created = createIdentity(relays, bootstrap, relays)
        // MDK hands every secret to our SecretStore (KvSecretStore), so the new
        // key is already in the Keystore-backed store; the 21607 proof of
        // possession needs it. (exportEncryptedSecretKey would also work, but its
        // NIP-49 scrypt cost needs ~256 MB, more than an app's Java heap.)
        val hex = kv.get("chat.mk:${created.accountIdHex}") ?: throw IllegalStateException("chat engine did not store the new device key")
        Bytes.fromHex(hex)
    }

    override suspend fun hasAccount(pubkey: String): Boolean = io { listAccounts().any { it.accountIdHex == pubkey } }

    override suspend fun ensureAccount(device: ChatDeviceKeys.Device, relays: List<String>, bootstrap: List<String>): String = io {
        fun find() = listAccounts().firstOrNull { it.accountIdHex == device.pubkey }
        val existing = find()
        val label = when {
            existing == null -> try {
                login(Nip19.nsec(device.secret), relays, bootstrap, relays).label
            } catch (e: MarmotKitException.DuplicateIdentity) {
                find()?.label ?: throw e
            }
            existing.signedOut -> signInAccount(existing.label).label
            else -> existing.label
        }
        // The device key serves every chat event of this account; its inbox must
        // name this event's relays too, or the coordinator's Welcome lands nowhere
        // this device listens.
        val want = relays.map(RelayPool::normalize).toSet()
        val inbox = runCatching { accountInboxRelays(label) }.getOrDefault(emptyList()).map(RelayPool::normalize).toSet()
        if (!inbox.containsAll(want)) runCatching { setAccountInboxRelays(label, relays, bootstrap) }.onFailure { Log.w(TAG, "inbox relays: ${it.javaClass.simpleName}") }
        val nip65 = runCatching { accountNip65Relays(label) }.getOrDefault(emptyList()).map(RelayPool::normalize).toSet()
        if (!nip65.containsAll(want)) runCatching { setAccountNip65Relays(label, relays, bootstrap) }.onFailure { Log.w(TAG, "nip65 relays: ${it.javaClass.simpleName}") }
        label
    }

    override suspend fun networkReady(account: String): Boolean = io {
        runCatching { accountSetupReadiness(account) == AccountSetupReadinessFfi.NETWORK_READY }.getOrDefault(false)
    }

    override suspend fun groups(account: String): List<GroupBinding.GroupInfo> = io {
        chatList(account, true).mapNotNull { row ->
            val d = runCatching { groupDetails(account, row.groupIdHex) }.getOrNull() ?: return@mapNotNull null
            GroupBinding.GroupInfo(
                groupIdHex = row.groupIdHex,
                nostrGroupIdHex = d.group.nostrGroupIdHex,
                welcomer = d.group.welcomerAccountIdHex,
                members = d.members.flatMap { listOfNotNull(it.memberIdHex, it.account) }.map(::hexOf).distinct(),
                selfMember = d.group.selfMembership == SelfMembershipFfi.MEMBER,
                pendingInvite = d.group.pendingConfirmation,
            )
        }
    }

    override suspend fun acceptInvite(account: String, groupIdHex: String) {
        io { runCatching { acceptGroupInvite(account, groupIdHex) }.onFailure { Log.w(TAG, "accept: ${it.javaClass.simpleName}") } }
    }

    override suspend fun confirmRejoin(account: String, groupIdHex: String, coordinator: String): Boolean = io {
        val status = runCatching { groupRecoveryStatus(account, groupIdHex) }.getOrNull() ?: return@io false
        val offer = status.rejoinInvitations.filter { hexOf(it.welcomerAccountIdHex) == coordinator }.maxByOrNull { it.epoch } ?: return@io false
        runCatching { confirmGroupRejoin(account, offer.welcomeIdHex, offer.localStateToken) }.isSuccess
    }

    override suspend fun rotateKeyPackage(account: String) { io { rotateKeyPackage(account) } }

    override suspend fun republishKeyPackage(account: String) { io { republishKeyPackage(account) } }

    override suspend fun sendText(account: String, groupIdHex: String, text: String): Boolean = io {
        sendText(account, groupIdHex, text).acceptDisposition == SendAcceptDispositionFfi.PUBLISHED
    }

    override suspend fun react(account: String, groupIdHex: String, messageId: String, emoji: String) {
        io { reactToMessage(account, groupIdHex, messageId, emoji) }
    }

    override suspend fun unreact(account: String, groupIdHex: String, messageId: String) {
        io { unreactFromMessage(account, groupIdHex, messageId) }
    }

    override fun changes(account: String): Flow<Unit> = events.filter { it == account }.map { }

    override fun timeline(account: String, groupIdHex: String, me: String): ChatEngine.TimelineHandle = object : ChatEngine.TimelineHandle {
        @Volatile private var sub: TimelineMessagesSubscription? = null
        @Volatile private var closed = false

        override val pages: Flow<ChatPage> = flow {
            val s = m().subscribeTimelineMessages(account, groupIdHex, WINDOW)
            if (closed) { s.close(); return@flow }
            sub = s
            try {
                s.snapshot()?.let { emit(convert(it, me)) }
                while (true) {
                    val p = s.next() ?: break
                    emit(convert(p, me))
                }
            } finally {
                runCatching { s.close() }
            }
        }.flowOn(Dispatchers.IO)

        override suspend fun older(count: Int): ChatPage? = withContext(Dispatchers.IO) {
            sub?.paginateBackwards(count.toUInt())?.let { convert(it, me) }
        }

        override fun close() { closed = true; sub = null }
    }

    private class KvSecretStore(private val kv: SecretKv) : SecretStore {
        private fun name(account: String) = "chat.mk:$account"
        override fun hasSecretForLabel(label: String): Boolean = kv.get("chat.mklabel:$label") != null
        override fun hasSecretForAccountId(accountIdHex: String): Boolean = kv.get(name(accountIdHex)) != null
        override fun writeSecret(label: String, accountIdHex: String, secretKeyHex: String) {
            kv.put(name(accountIdHex), secretKeyHex)
            kv.put("chat.mklabel:$label", accountIdHex)
        }
        override fun loadSecret(label: String, accountIdHex: String): String =
            kv.get(name(accountIdHex)) ?: throw MarmotKitException.SecretNotFound("no chat secret for this account")
        override fun removeSecret(label: String, accountIdHex: String) {
            kv.put(name(accountIdHex), null)
            kv.put("chat.mklabel:$label", null)
        }
    }

    companion object {
        private const val TAG = "MarmotEngine"
        private const val GRACE_MS = 20_000L
        private val WINDOW = 200u
        @Volatile private var nativeReady = false

        /** Our public KeyPackage client label (the PWA tags its own `nostrautica-web`). */
        val CLIENT_NAME = "nostrautica-android"

        fun defaultDeviceLabel(): String = "Android (${Build.MODEL ?: "phone"})".take(60)

        /** MDK reports member/account ids as hex; tolerate an npub just in case. */
        fun hexOf(id: String): String = if (id.startsWith("npub1")) runCatching { Nip19.decodeNpub(id) }.getOrDefault(id) else id.lowercase()

        fun convert(p: TimelinePageFfi, me: String): ChatPage =
            ChatPage(p.messages.filter { it.kind == 9uL }.map { toMessage(it, me) }, p.hasMoreBefore)

        private fun toMessage(r: TimelineMessageRecordFfi, me: String) = ChatMessage(
            id = r.messageIdHex,
            sender = hexOf(r.sender),
            text = if (r.deleted) "" else r.plaintext,
            at = r.timelineAt.toLong().let { if (it > 100_000_000_000L) it / 1000 else it },
            edited = r.edit != null,
            deleted = r.deleted,
            reactions = r.reactions.byEmoji.map { ChatMessage.Reaction(it.emoji, it.count.toInt(), it.senders.any { s -> hexOf(s) == me }) },
        )
    }
}
