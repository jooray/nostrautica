package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.domain.dm.dms
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip19
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
    ): Boolean = attestTimed(ctx, op, chatPubkey, label, clientId, deviceSecret, code).published

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
    ): Attested {
        val coordinator = ctx.cfg.coordinator ?: throw IllegalStateException("chat attestation requires a coordinator")
        val account = c.accounts.pubkey
        val createdAt = nowSec()
        val content = ChatAttest.content(ctx.coordinate, account, op, chatPubkey, createdAt, label, clientId, deviceSecret, code)
        val wrap = c.accounts.wrap(coordinator, Kinds.CHAT_KEY_ATTESTATION, ChatAttest.json(content), listOf(listOf("a", ctx.coordinate)), createdAt)
        return Attested(c.accounts.publishWrapToAccount(wrap, coordinator, ctx.relays, "chat") is Nostr.PublishResult.Published, createdAt, wrap.id)
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

    /** The last roster with attendees fetched per (account, event), and when, in this process. */
    private val rosterMemo = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, RosterContent>>()

    /**
     * The roster from the relays, or one fetched no longer than [reuseMs] ago (audit
     * S-2: every chat open fetched it again). Returns it with the time it was fetched,
     * so the caller can tell how fresh it is. Only a roster with attendees is reused;
     * an empty one is what the fetch returns when no relay had the roster at all.
     */
    suspend fun fetchRoster(ctx: EventContext, account: String, reuseMs: Long = 0): Pair<RosterContent, Long>? {
        val key = "$account|${ctx.coordinate}"
        val now = System.currentTimeMillis()
        rosterMemo[key]?.let { (at, r) -> if (reuseMs > 0 && now - at < reuseMs) return r to at }
        val r = runCatching { c.members.fetchRoster(ctx, account) }.getOrNull() ?: return null
        if (r.attendees.isNotEmpty()) rosterMemo[key] = now to r
        return r to now
    }

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
