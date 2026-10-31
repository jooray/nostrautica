package today.cypherpunk.nostrautica.domain.chat

import android.content.Context
import android.os.Build
import android.util.Log
import dev.ipf.marmotkit.AccountSetupReadinessFfi
import dev.ipf.marmotkit.GroupEventKindFfi
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
import dev.ipf.marmotkit.marmotDeploymentWhiteNoise
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
import kotlinx.coroutines.withTimeoutOrNull
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
    private val events = MutableSharedFlow<Pair<String, ChatEngine.Change>>(extraBufferCapacity = 64)
    private val freshness = RuntimeFreshness()
    /** Per device key: relays both its inbox and NIP-65 lists were seen to contain. */
    private val relaysVerified = java.util.concurrent.ConcurrentHashMap<String, Set<String>>()
    /** Per group: MDK stall/fork signals seen on the event stream since the last recovery. */
    private val trouble = GroupTrouble()

    /** Hold the runtime open. Pair every call with [release]. */
    override suspend fun acquire() {
        // A reference counts only once open() succeeded, and an acquire that fails or is
        // cancelled afterwards (withContext rethrows a cancellation even when its block
        // finished) gives it back: the caller never got it, so it never calls release(),
        // and a leaked ref kept the native runtime, its database and sockets open for the
        // life of the process (DS41-060).
        //
        // Bounded (review of audit K-6): the lock can be held by a close() or a
        // refreshIfStale() whose native shutdown or start never returns, and an
        // unbounded wait left the chat on "Connecting" forever. A timeout is an
        // ordinary failure (the session shows its error and Try again), not a
        // cancellation, which the session would take as "stopped" and show nothing.
        var counted = false
        val done = try {
            withTimeoutOrNull(ACQUIRE_TIMEOUT_MS) {
                withContext(Dispatchers.IO) {
                    lock.withLock {
                        closeJob?.cancel(); closeJob = null
                        if (marmot == null) marmot = open()
                        refs++
                        counted = true
                    }
                }
                true
            }
        } catch (e: Throwable) {
            if (counted) release()
            throw e
        }
        if (done == null) {
            if (counted) release()
            throw ChatEngineTimeout("the chat runtime did not open within ${ACQUIRE_TIMEOUT_MS / 1000} s")
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
            // MDK 0.14 made the services 0.13 compiled in (recovery-operated relays,
            // discovery indexers, media and image servers, KeyPackage ranking) a
            // host choice. The White Noise preset keeps exactly what this app ran on,
            // and our rooms are White Noise rooms. Its keychain service is unused:
            // secrets go through KvSecretStore.
            deployment = marmotDeploymentWhiteNoise(),
        )
        val deadline = System.currentTimeMillis() + BUSY_WAIT_MS
        val m = run {
            while (true) {
                try {
                    return@run Marmot.newWithConfiguration(root.path, bootstrapRelays, options)
                } catch (e: MarmotKitException.RuntimeBusy) {
                    // A previous runtime of this process is still closing its root.
                    if (System.currentTimeMillis() >= deadline) throw ChatEngineTimeout("the chat store is still busy after ${BUSY_WAIT_MS / 1000} s")
                    delay(250)
                }
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }
        val started = try {
            withTimeoutOrNull(START_TIMEOUT_MS) { m.start(); true }
        } catch (e: Throwable) {
            shutdownQuietly(m)
            throw e
        }
        if (started == null) {
            shutdownQuietly(m)
            throw ChatEngineTimeout("the chat runtime did not start within ${START_TIMEOUT_MS / 1000} s")
        }
        // start() registers the group subscriptions for every group the store holds.
        freshness.restarted()
        eventsJob = scope.launch {
            val sub = m.subscribeEvents()
            try {
                while (isActive) {
                    val e = sub.next() ?: break
                    noteTrouble(e)
                    changeOf(e)?.let { events.tryEmit(it) }
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
        shutdownQuietly(m)
    }

    /** Shut [m] down, bounded: a native shutdown that never returns must not hold [lock] forever. */
    private suspend fun shutdownQuietly(m: Marmot) {
        withContext(NonCancellable) {
            val r = runCatching { withTimeoutOrNull(SHUTDOWN_TIMEOUT_MS) { m.shutdownAndClose() } }
            r.onFailure { Log.w(TAG, "shutdown: ${it.javaClass.simpleName}") }
            if (r.isSuccess && r.getOrNull() == null) Log.w(TAG, "shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000} s")
            runCatching { m.close() }
        }
    }

    override suspend fun refreshIfStale(): Boolean = withContext(Dispatchers.IO) {
        lock.withLock {
            if (marmot == null || !freshness.shouldRestart(refs)) return@withLock false
            Log.i(TAG, "restarting the chat runtime (${freshness.reason()})")
            close()
            marmot = open()
            true
        }
    }

    /**
     * Account label and what happened. Messages are told apart from group state so a
     * busy room doesn't re-read every group on every message (audit R-7): the open
     * timeline renders messages itself.
     */
    private fun changeOf(e: MarmotEventFfi): Pair<String, ChatEngine.Change>? {
        val state = ChatEngine.ChangeKind.STATE
        val message = ChatEngine.ChangeKind.MESSAGE
        val health = ChatEngine.ChangeKind.HEALTH
        return when (e) {
            is MarmotEventFfi.GroupJoined -> e.accountLabel to ChatEngine.Change(e.groupIdHex, state)
            is MarmotEventFfi.GroupStateUpdated -> e.accountLabel to ChatEngine.Change(e.groupIdHex, state)
            is MarmotEventFfi.GroupEvent -> e.accountLabel to ChatEngine.Change(e.groupIdHex, when (e.event) {
                is GroupEventKindFfi.MessageReceived, is GroupEventKindFfi.AppMessageInvalidated,
                is GroupEventKindFfi.TransportObjectResourceRefused -> message
                is GroupEventKindFfi.GroupUnrecoverable -> health
                else -> state
            })
            is MarmotEventFfi.MessageReceived -> e.received.accountLabel to ChatEngine.Change(e.received.message.groupIdHex, message)
            is MarmotEventFfi.WelcomeDeliveryPending -> e.accountLabel to ChatEngine.Change(e.groupIdHex, state)
            is MarmotEventFfi.EpochStallEscalated -> e.accountLabel to ChatEngine.Change(e.groupIdHex, health)
            is MarmotEventFfi.GroupChangeSuperseded -> e.accountLabel to ChatEngine.Change(e.groupIdHex, health)
            is MarmotEventFfi.HistoryNoticesChanged -> e.accountLabel to ChatEngine.Change(null, health)
            else -> null
        }
    }

    /** Record or clear a group's stall/fork signals (audit R-9). */
    private fun noteTrouble(e: MarmotEventFfi) {
        when (e) {
            is MarmotEventFfi.EpochStallEscalated -> trouble.mark(e.groupIdHex, GroupTrouble.STALLED)
            is MarmotEventFfi.GroupChangeSuperseded ->
                if (GroupTrouble.supersededNeedsAttention(e.outcome)) trouble.mark(e.groupIdHex, GroupTrouble.SUPERSEDED)
            is MarmotEventFfi.GroupEvent -> when (e.event) {
                is GroupEventKindFfi.GroupUnrecoverable -> trouble.mark(e.groupIdHex, GroupTrouble.UNRECOVERABLE)
                // The group moved on, or MDK says it recovered.
                is GroupEventKindFfi.EpochChanged, is GroupEventKindFfi.GroupHydrationRecovered,
                is GroupEventKindFfi.PendingCommitRecovered -> trouble.clear(e.groupIdHex, GroupTrouble.STALLED, GroupTrouble.SUPERSEDED)
                is GroupEventKindFfi.LocalGroupCopyRestored -> trouble.clear(e.groupIdHex, GroupTrouble.STALLED, GroupTrouble.SUPERSEDED, GroupTrouble.UNRECOVERABLE)
                else -> {}
            }
            else -> {}
        }
    }

    override suspend fun syncHealth(account: String, groupIdHex: String, unrecoverable: Boolean): ChatEngine.SyncHealth = io {
        val status = runCatching { groupRecoveryStatus(account, groupIdHex) }.getOrNull()
        ChatEngine.SyncHealth(
            stalled = trouble.has(groupIdHex, GroupTrouble.STALLED),
            superseded = trouble.has(groupIdHex, GroupTrouble.SUPERSEDED),
            unrecoverable = unrecoverable || trouble.has(groupIdHex, GroupTrouble.UNRECOVERABLE),
            automaticRecoveryFailed = status?.automaticRecoveryFailed == true,
            historyMayBeIncomplete = status?.historyMayBeIncomplete == true,
        )
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
        // Both lists already known to cover these relays in this process: skip the two
        // native reads (audit S-2, they ran on every chat open and twice on some).
        if (relaysVerified[device.pubkey]?.containsAll(want) == true) return@io label
        val inbox = runCatching { accountInboxRelays(label) }.getOrDefault(emptyList()).map(RelayPool::normalize).toSet()
        var changed = false
        if (!inbox.containsAll(want)) runCatching { setAccountInboxRelays(label, relays, bootstrap) }
            .onSuccess { changed = true }.onFailure { Log.w(TAG, "inbox relays: ${it.javaClass.simpleName}") }
        val nip65 = runCatching { accountNip65Relays(label) }.getOrDefault(emptyList()).map(RelayPool::normalize).toSet()
        if (!nip65.containsAll(want)) runCatching { setAccountNip65Relays(label, relays, bootstrap) }
            .onSuccess { changed = true }.onFailure { Log.w(TAG, "nip65 relays: ${it.javaClass.simpleName}") }
        // A fresh account has no group subscription to break; one that holds groups does.
        if (changed && runCatching { chatList(label, true).isNotEmpty() }.getOrDefault(false)) freshness.relayListsChanged()
        // Remembered only once both lists are known to hold every wanted relay.
        val nowInbox = if (changed) runCatching { accountInboxRelays(label) }.getOrDefault(emptyList()).map(RelayPool::normalize).toSet() else inbox
        val nowNip65 = if (changed) runCatching { accountNip65Relays(label) }.getOrDefault(emptyList()).map(RelayPool::normalize).toSet() else nip65
        if (nowInbox.containsAll(want) && nowNip65.containsAll(want)) relaysVerified[device.pubkey] = nowInbox.intersect(nowNip65)
        label
    }

    override suspend fun networkReady(account: String): Boolean = io {
        runCatching { accountSetupReadiness(account) == AccountSetupReadinessFfi.NETWORK_READY }.getOrDefault(false)
    }

    /**
     * Every group, or a failure: a row whose details can't be read fails the whole
     * call instead of vanishing from the list (audit K-4 A-2). A silently shorter
     * list read as "the room's group is not here", and the session attested, which
     * makes the coordinator evict and re-add a device that was in the room all along.
     */
    override suspend fun groups(account: String): List<GroupBinding.GroupInfo> = io {
        chatList(account, true).map { row ->
            val d = groupDetails(account, row.groupIdHex)
            GroupBinding.GroupInfo(
                groupIdHex = row.groupIdHex,
                nostrGroupIdHex = d.group.nostrGroupIdHex,
                welcomer = d.group.welcomerAccountIdHex?.let(::hexOf),
                // MDK returns an empty list, never null, when it has no members to report.
                members = d.members.flatMap { listOfNotNull(it.memberIdHex, it.account) }.map(::hexOf).distinct().takeIf { it.isNotEmpty() },
                selfMember = d.group.selfMembership == SelfMembershipFfi.MEMBER,
                pendingInvite = d.group.pendingConfirmation,
                unrecoverable = d.group.unrecoverable,
            )
        }
    }

    override suspend fun acceptInvite(account: String, groupIdHex: String): Boolean = io {
        runCatching { acceptGroupInvite(account, groupIdHex) }
            .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; Log.w(TAG, "accept: ${it.javaClass.simpleName}") }
            .isSuccess
    }

    override suspend fun confirmRejoin(account: String, groupIdHex: String, coordinator: String): Boolean = io {
        val status = runCatching { groupRecoveryStatus(account, groupIdHex) }.getOrNull() ?: return@io false
        val offer = status.rejoinInvitations.filter { hexOf(it.welcomerAccountIdHex) == coordinator }.maxByOrNull { it.epoch } ?: return@io false
        runCatching { confirmGroupRejoin(account, offer.welcomeIdHex, offer.localStateToken) }.isSuccess
            .also { if (it) freshness.rejoined(groupIdHex) }
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

    override suspend fun edit(account: String, groupIdHex: String, messageId: String, content: String) {
        io { editMessage(account, groupIdHex, messageId, content) }
    }

    override suspend fun delete(account: String, groupIdHex: String, messageId: String) {
        io { deleteMessage(account, groupIdHex, messageId) }
    }

    override fun changes(account: String): Flow<ChatEngine.Change> = events.filter { it.first == account }.map { it.second }

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
        /** The longest [acquire] waits for the runtime (lock, open and start together). */
        private const val ACQUIRE_TIMEOUT_MS = 60_000L
        /** How long a busy store root (a runtime still closing) is waited out. */
        private const val BUSY_WAIT_MS = 15_000L
        private const val START_TIMEOUT_MS = 30_000L
        private const val SHUTDOWN_TIMEOUT_MS = 15_000L
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
