package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.signer.Session

/** The blinding seed could not be read; minting a new one would orphan every record (blinding.ts). */
class BlindSeedUnavailable : Exception("blinding seed could not be read and must not be replaced by a guess")

/**
 * Account-level helpers every feature uses: the blinding key, gift-wrap routing,
 * monotonic timestamps for replaceables, and publishing as the signed-in user.
 */
class Accounts(private val session: Session, private val nostr: Nostr, private val cache: Cache) {
    private val blindLock = Mutex()
    private val blind = HashMap<String, ByteArray>()
    private val monoLock = Mutex()

    val account get() = session.account.value
    fun requireAccount(): Session.Account = account ?: throw IllegalStateException("not signed in")
    val signer: NostrSigner get() = requireAccount().signer
    val pubkey: String get() = requireAccount().pubkey

    /**
     * blinding.ts deriveBlindingKey. A local key derives it (self conversation key);
     * a remote signer keeps a random seed self-encrypted in 30078
     * `nostrautica:blindseed`. Never mint a new seed unless a relay has answered
     * that none exists.
     */
    suspend fun blindingKey(): ByteArray = blindLock.withLock {
        val acct = requireAccount()
        blind[acct.pubkey]?.let { return@withLock it }
        val key = (acct.signer as? LocalSigner)?.let { Nip44.selfConversationKey(it.secret()) } ?: remoteSeed(acct.signer)
        blind[acct.pubkey] = key
        key
    }

    private suspend fun remoteSeed(signer: NostrSigner): ByteArray {
        val pk = signer.pubkey
        cache.get(pk, "blindseed", String.serializer())?.let { b64 ->
            Bytes.fromBase64(b64).takeIf { it.size == 32 }?.let { return it }
        }
        val f = Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(pk), tags = mapOf("d" to listOf(BLINDSEED_D)))
        val r = nostr.fetch(Relays.READ, f)
        val existing = nostr.store.latest(Kinds.APP_DATA, pk, BLINDSEED_D)
        if (existing != null) {
            val b64 = signer.nip44Decrypt(pk, existing.content)
            val bytes = runCatching { Bytes.fromBase64(b64) }.getOrNull()
            if (bytes?.size == 32) {
                cache.put(pk, "blindseed", String.serializer(), b64, existing.createdAt)
                return bytes
            }
            throw BlindSeedUnavailable()
        }
        if (r.answered == 0) throw BlindSeedUnavailable()
        val seed = Bytes.random(32)
        val b64 = Bytes.toBase64(seed)
        val ev = signer.sign(signer.template(Kinds.APP_DATA, signer.nip44Encrypt(pk, b64), listOf(listOf("d", BLINDSEED_D))))
        nostr.publish(ev, Relays.DEFAULT, pk, "blindseed")
        cache.put(pk, "blindseed", String.serializer(), b64, ev.createdAt)
        return seed
    }

    /** A recipient's NIP-17 inbox relays (10050), from the store if we have them, else fetched. */
    suspend fun inboxRelays(pubkey: String): List<String> {
        val f = Filter(kinds = listOf(Kinds.DM_RELAY_LIST), authors = listOf(pubkey))
        if (!cache.isFresh("10050:$pubkey", 30 * 60_000L)) {
            nostr.fetch(Relays.READ, f)
            cache.markFetched("10050:$pubkey")
        }
        val e = nostr.store.latest(Kinds.DM_RELAY_LIST, pubkey) ?: return emptyList()
        return e.tagValues("relay").filter { it.startsWith("wss://") }.take(Relays.MAX_DM_RELAYS)
    }

    /** Publish a wrap addressed to an account: its 10050 inboxes ∪ the event's relays ∪ defaults. */
    suspend fun publishWrapToAccount(wrap: NostrEvent, recipient: String, eventRelays: List<String>, label: String? = null): Nostr.PublishResult {
        val relays = (inboxRelays(recipient) + eventRelays + Relays.DEFAULT).map(RelayPool::normalize).distinct().take(Relays.MAX_DM_RELAYS)
        return nostr.publish(wrap, relays, pubkey, label)
    }

    /** Gift-wrap a rumor from the signed-in user. */
    suspend fun wrap(recipient: String, kind: Int, content: String, tags: List<List<String>> = emptyList(), createdAt: Long = nowSec()): NostrEvent =
        GiftWrap.wrap(signer, recipient, GiftWrap.rumor(pubkey, kind, content, tags, createdAt))

    /**
     * created_at = max(now, previous + 1) for a replaceable/addressable event
     * (nostr/monotonic.ts, NIP §3.2), so a quick second edit never loses to the first.
     */
    suspend fun monotonicCreatedAt(kind: Int, author: String, d: String? = null): Long = monoLock.withLock {
        val prev = nostr.store.latest(kind, author, d)?.createdAt ?: 0
        maxOf(nowSec(), prev + 1)
    }

    /** Sign and publish as the user. */
    suspend fun signAndPublish(kind: Int, content: String, tags: List<List<String>>, relays: List<String>, label: String? = null): Pair<NostrEvent, Nostr.PublishResult> {
        val d = tags.firstOrNull { it.size >= 2 && it[0] == "d" }?.get(1)
        val created = if (Kinds.isReplaceable(kind) || Kinds.isAddressable(kind)) monotonicCreatedAt(kind, pubkey, d) else nowSec()
        val ev = signer.sign(UnsignedEvent(pubkey, created, kind, tags, content))
        return ev to nostr.publish(ev, relays, pubkey, label)
    }

    /**
     * Unwrap a gift wrap addressed to the user, at most once per wrap ever: the
     * authenticated rumor is kept in the owner cache, so the grant scan and the
     * DM inbox (which both read every 1059 `#p` = me) never ask a remote signer
     * to decrypt the same wrap twice. Only successes are cached; the caller
     * decides what a failure means.
     */
    suspend fun unwrap(wrap: NostrEvent, allowedKinds: Set<Int>): Rumor {
        val acct = requireAccount()
        val key = "rumor:${wrap.id}"
        cache.get(acct.pubkey, key, Rumor.serializer())?.let { r ->
            if (r.kind !in allowedKinds) throw GiftWrap.UnwrapException("rumor kind ${r.kind} is not accepted here")
            return r
        }
        // Unwrap with every kind this account may receive, so the cached result
        // serves whichever caller comes next; then apply this caller's allowlist.
        val r = GiftWrap.unwrap(wrap, acct.signer, Kinds.ATTENDEE_RUMOR_KINDS + Kinds.ORGANIZER_RUMOR_KINDS)
        cache.put(acct.pubkey, key, Rumor.serializer(), r, wrap.createdAt)
        if (r.kind !in allowedKinds) throw GiftWrap.UnwrapException("rumor kind ${r.kind} is not accepted here")
        return r
    }

    fun forget(pubkey: String) { blind.remove(pubkey) }

    companion object {
        const val BLINDSEED_D = "nostrautica:blindseed"
    }
}
