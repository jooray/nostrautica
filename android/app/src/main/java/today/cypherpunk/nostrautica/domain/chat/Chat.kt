package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.domain.dm.dms
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.organizer.DiscoveredCoordinator
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.CoordinatorAnnounce
import today.cypherpunk.nostrautica.protocol.CoordinatorFeatures
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.signer.silently

/** Registered lazily: nothing chat-related (and no native code) exists until chat is used. */
val AppContainer.chat: Chat get() = area("chat") { Chat(this) }

/**
 * Event group chat (Marmot/MLS) for the app: one [ChatSession] per (account,
 * event), the 21607 attestations that bind this phone's chat device key to the
 * account, and the small helpers the chat screens share.
 */
class Chat(internal val c: AppContainer) {
    private val kv = object : SecretKv {
        override fun get(name: String): String? = c.secure.get(name)
        override fun put(name: String, value: String?) = c.secure.put(name, value)
    }
    val keys = ChatDeviceKeys(kv)
    val engine: MarmotEngine by lazy { MarmotEngine(c.context, kv, (Relays.DEFAULT + Relays.CHAT_INTEROP).map(RelayPool::normalize).distinct()) }
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessions = HashMap<String, ChatSession>()

    fun session(ctx: EventContext, account: String): ChatSession = synchronized(sessions) {
        sessions.getOrPut("$account|${ctx.coordinate}") { ChatSession(this, ctx, account, engine) }
    }

    /** The relays this event's chat uses: its relays ∪ its chat (interop) relays. */
    fun chatRelays(ctx: EventContext): List<String> = Relays.forChat(ctx.cfg)

    /**
     * Gift-wrap a 21607 to the event's coordinator, sealed by the account's signer.
     * The rumor's `created_at` is the one the proof of possession signs. Returns
     * true when it reached a relay, false when it is waiting in the outbox.
     */
    suspend fun attest(
        ctx: EventContext,
        op: ChatAttest.Op,
        chatPubkey: String,
        label: String? = null,
        clientId: String? = null,
        deviceSecret: ByteArray? = null,
        code: String? = null,
        intent: ChatAttest.Intent? = null,
    ): Boolean = attestTimed(ctx, op, chatPubkey, label, clientId, deviceSecret, code, intent).published

    /** One sent attestation: whether it reached a relay, the rumor's `created_at`, the wrap's id. */
    data class Attested(val published: Boolean, val createdAt: Long, val wrapId: String)

    /** [attest], also returning the `created_at` the coordinator orders attestations by. */
    suspend fun attestTimed(
        ctx: EventContext,
        op: ChatAttest.Op,
        chatPubkey: String,
        label: String? = null,
        clientId: String? = null,
        deviceSecret: ByteArray? = null,
        code: String? = null,
        intent: ChatAttest.Intent? = null,
    ): Attested {
        val coordinator = ctx.cfg.coordinator ?: throw IllegalStateException("chat attestation requires a coordinator")
        val account = c.accounts.pubkey
        val createdAt = nowSec()
        val content = ChatAttest.content(ctx.coordinate, account, op, chatPubkey, createdAt, label, clientId, deviceSecret, code, intent)
        val wrap = c.accounts.wrap(coordinator, Kinds.CHAT_KEY_ATTESTATION, ChatAttest.json(content), listOf(listOf("a", ctx.coordinate)), createdAt)
        return Attested(c.accounts.publishWrapToAccount(wrap, coordinator, ctx.relays, "chat") is Nostr.PublishResult.Published, createdAt, wrap.id)
    }

    // ── Does the event's coordinator understand the add `intent`? (NIP §6.2) ──

    /**
     * What is known without the network: this coordinator's own cached `features`,
     * else the coordinator picker's cached list. Null = unknown, which sends no intent.
     */
    suspend fun knownIntentSupport(coordinator: String?): Boolean? {
        val pk = coordinator?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        c.cache.get(Cache.ANON, featuresKey(pk), CoordinatorFeatures.serializer())?.let { return it.attestIntent }
        val listed = c.cache.get(Cache.ANON, "coordinators", ListSerializer(DiscoveredCoordinator.serializer()))
        return listed?.firstOrNull { it.pubkey.equals(pk, true) }?.announce?.features?.attestIntent
    }

    /**
     * Read the coordinator's latest 31611 in the background when the cached answer is
     * missing or older than an hour. Never awaited by enrolment: the next attestation
     * uses what it finds.
     */
    fun prefetchIntentSupport(coordinator: String?) {
        val pk = coordinator?.lowercase()?.takeIf { it.isNotEmpty() } ?: return
        scope.launch {
            runCatching {
                if (c.cache.isFresh(featuresKey(pk), INTENT_SUPPORT_TTL_MS)) return@launch
                val r = c.nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.COORDINATOR_ANNOUNCE), authors = listOf(pk), limit = 1))
                var latest: NostrEvent? = null
                for (e in r.events) {
                    if (!e.pubkey.equals(pk, true) || e.kind != Kinds.COORDINATOR_ANNOUNCE) continue
                    if (latest == null || Ordering.supersedes(e, latest)) latest = e
                }
                val ev = latest ?: return@launch
                val a = (Wire.parseSafe(CoordinatorAnnounce.serializer(), ev.content) as? Wire.Result.Ok)?.value ?: return@launch
                c.cache.put(Cache.ANON, featuresKey(pk), CoordinatorFeatures.serializer(), a.features, ev.createdAt)
                c.cache.markFetched(featuresKey(pk))
            }.onFailure { if (it is CancellationException) throw it }
        }
    }

    private fun featuresKey(pk: String) = "coordinator-chat-features:$pk"

    private companion object {
        /** A cached answer about the coordinator's `features` is re-read after this. */
        const val INTENT_SUPPORT_TTL_MS = 3600_000L
    }

    /** Take a queued attestation back out of the outbox, so it is never sent. */
    suspend fun discardQueued(wrapId: String) = c.nostr.discard(wrapId)

    /**
     * A NIP-17 DM for `/msg` (events/dm.ts sendDm): one rumor, wrapped to the
     * recipient and to ourselves, through the DM service so it also shows in the
     * thread with that person.
     */
    suspend fun sendDm(peer: String, text: String): Boolean =
        c.dms.send(peer, text) is Nostr.PublishResult.Published

    /**
     * The device key's own kind-0 (NIP §10.3), so other Marmot clients show a name:
     * the account's display name, an `about` pointing at the account npub, its
     * picture. Published to the chat relays only, never anywhere else; the account's
     * own kind-0 is read from the general relays, never from the chat ones.
     */
    suspend fun publishDeviceProfile(device: ChatDeviceKeys.Device, relays: List<String>) {
        // The account's kind-0 read is TTL-cached by Profiles (6 h), so this is cheap.
        runCatching { c.profiles.refresh(listOf(device.account)) }
        val meta = c.profiles.local(device.account)
        val npub = Nip19.npub(device.account)
        val content = buildJsonObject {
            put("name", meta?.name?.trim()?.takeIf { it.isNotEmpty() } ?: "Nostrautica user")
            put("about", "Nostrautica MLS chat key for a Nostrautica event, not a person. Follow $npub for the main account this belongs to. Messages are end-to-end encrypted.")
            meta?.picture?.let { put("picture", it) }
        }.toString()
        // Only when the content or the relay set changed, or a week went by (audit S-2):
        // it went out on every chat open before.
        val hash = DeviceProfileStamp.hash(content, relays.map(RelayPool::normalize))
        val stampKey = "chat.profilestamp:${device.pubkey}"
        val now = nowSec()
        if (!DeviceProfileStamp.due(kv.get(stampKey), hash, now)) return
        val ev = LocalSigner(device.secret).signNow(UnsignedEvent(device.pubkey, now, Kinds.PROFILE, emptyList(), content))
        if (c.nostr.publish(ev, relays, device.account, null) is Nostr.PublishResult.Published) kv.put(stampKey, DeviceProfileStamp.stamp(hash, now))
    }

    suspend fun cachedRoster(account: String, coordinate: String): RosterContent? = c.members.cachedRoster(account, coordinate)

    private val rosterReads = RosterReads()

    /**
     * The roster from the relays, or one fetched no longer than [reuseMs] ago (audit
     * S-2: every chat open fetched it again). See [RosterReads] for what counts as fresh.
     */
    suspend fun fetchRoster(ctx: EventContext, account: String, reuseMs: Long = 0): RosterReads.Fetched? =
        rosterReads.fetch("$account|${ctx.coordinate}", reuseMs) { runCatching { c.members.readRoster(ctx, account) }.getOrNull() }

    /** This attendee's own 21606 notices for the event (latest per stage). */
    suspend fun ownStatuses(account: String, coordinate: String): List<CoordinatorStatusContent> =
        c.grants.ownStatuses(account, coordinate)

    /** Pull new 21606 notices without ever prompting a remote signer. */
    suspend fun scanNotices() {
        val signer = c.accounts.account?.signer ?: return
        runCatching { silently { c.grants.receive(signer, maxUnwraps = 20) } }
    }

    /** Warm sender/member names before the room paints (warm.ts). */
    fun warmProfiles(roster: RosterContent?, chatRelays: List<String>) {
        val (accounts, devices) = ChatMembers.profilePubkeys(roster)
        scope.launch {
            runCatching { c.profiles.refresh(accounts) }
            runCatching { c.profiles.refresh(devices, chatRelays) }
        }
    }
}
