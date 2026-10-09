package today.cypherpunk.nostrautica.domain.dm

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.DmReadPosition
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.isHex32
import today.cypherpunk.nostrautica.protocol.nowSec

/** One NIP-17 message (events/dm.ts DmMessage). */
@Serializable
data class DmMessage(
    /** Rumor id: identical in the recipient's and the sender's self copy. */
    val id: String,
    /** The other party. */
    val peer: String,
    /** Author: == peer for received, == me for sent. */
    val from: String,
    val text: String,
    /** Rumor created_at (wrap timestamps are randomized, NIP-59). */
    val at: Long,
    /** For a message sent from this phone: the recipient copy's wrap id, so the UI can tell "still in the outbox". */
    val outWrap: String? = null,
)

data class DmThread(val peer: String, val last: DmMessage, val count: Int)

/** The persisted per-wrap unwrap memo entry: the message, or null for "decrypted fine, not a DM of ours". */
@Serializable
data class DmMemoEntry(val m: DmMessage? = null, val wrapAt: Long = 0)

/** The inbox scan cursor (dm.ts DmScanState). */
@Serializable
data class DmScanState(val lastScan: Long? = null, val historyUntil: Long? = null, val historyComplete: Boolean = false)

/** The ciphertext-only activity ledger (dm-unread.svelte.ts EncryptedActivity). */
@Serializable
data class DmActivity(val initialized: Boolean = false, val known: List<String> = emptyList(), val pending: List<String> = emptyList())

typealias Watermarks = Map<String, DmReadPosition>

/**
 * The pure half of the PWA's events/dm.ts, events/dm-read-state.ts and
 * stores/dm-unread.svelte.ts: grouping, the optimistic merge, relay selection and
 * every read-state rule, so they are unit-tested without a phone.
 */
object DmLogic {
    const val MAX_DM_WRAPS = 3000
    const val HISTORY_PAGE_LIMIT = 200
    const val HISTORY_PAGES_PER_SCAN = 5
    const val MAX_UNWRAP_ATTEMPTS = 5
    const val MAX_WRAP_IDS = 3000

    // ── Messages ────────────────────────────────────────────────────────────

    /** A kind-14 rumor as a message of [me]'s, or null when it is not one (definitive). */
    fun classify(rumor: Rumor, me: String): DmMessage? {
        if (rumor.kind != Kinds.DM) return null
        val recipient = rumor.tag("p") ?: return null
        val peer = if (rumor.pubkey == me) recipient else rumor.pubkey
        if (peer == me && rumor.pubkey != me) return null
        if (!peer.isHex32()) return null
        return DmMessage(rumor.id, peer, rumor.pubkey, rumor.content, rumor.createdAt)
    }

    /** Messages from the memo, one per rumor id, oldest first. */
    fun snapshot(memo: Map<String, DmMemoEntry>): List<DmMessage> {
        val byId = LinkedHashMap<String, DmMessage>()
        for (e in memo.values) {
            val m = e.m ?: continue
            val prev = byId[m.id]
            // Keep the copy that knows its outbox wrap, so "queued" survives the self copy arriving.
            if (prev == null || (prev.outWrap == null && m.outWrap != null)) byId[m.id] = m
        }
        return byId.values.sortedWith(compareBy<DmMessage> { it.at }.thenBy { it.id })
    }

    /**
     * Cap the memo to the [MAX_DM_WRAPS] newest wraps (dm.ts persistUnwrapCache).
     * Ranked by WRAP time, not message time, because the pending scan skips every
     * wrap older than the oldest one kept: the two must agree, or a pruned wrap
     * would be decrypted again on every pass.
     */
    fun capMemo(memo: Map<String, DmMemoEntry>, max: Int = MAX_DM_WRAPS): Map<String, DmMemoEntry> {
        if (memo.size <= max) return memo
        return memo.entries.sortedByDescending { it.value.wrapAt }.take(max)
            .associateTo(LinkedHashMap()) { it.key to it.value }
    }

    /** Per-peer threads, newest first (dm.ts threadsOf). */
    fun threadsOf(messages: List<DmMessage>): List<DmThread> {
        val byPeer = LinkedHashMap<String, DmThread>()
        for (m in messages) {
            val t = byPeer[m.peer]
            byPeer[m.peer] = if (t == null) DmThread(m.peer, m, 1) else t.copy(last = if (m.at >= t.last.at) m else t.last, count = t.count + 1)
        }
        return byPeer.values.sortedByDescending { it.last.at }
    }

    // ── Relays ──────────────────────────────────────────────────────────────

    fun isAcceptedRelayUrl(url: String): Boolean {
        val u = runCatching { java.net.URI(url.trim()) }.getOrNull() ?: return false
        return when (u.scheme?.lowercase()) {
            "wss" -> !u.host.isNullOrEmpty()
            "ws" -> u.host in setOf("localhost", "127.0.0.1", "[::1]", "::1")
            else -> false
        }
    }

    fun relayUrlsFromDmList(tags: List<List<String>>): List<String> =
        tags.filter { it.size >= 2 && it[0] == "relay" && isAcceptedRelayUrl(it[1]) }.map { RelayPool.normalize(it[1]) }
            .distinct().take(Relays.MAX_DM_RELAYS)

    /**
     * dm.ts selectDmRelays: the recipient's 10050 inboxes, capped so they never
     * crowd out the app defaults, then the defaults.
     */
    fun selectDmRelays(recipientDmRelays: List<String>, defaults: List<String> = Relays.DEFAULT): List<String> {
        val safeDefaults = defaults.filter(::isAcceptedRelayUrl).map(RelayPool::normalize).distinct().take(Relays.MAX_DM_RELAYS)
        val defaultSet = safeDefaults.toSet()
        val recipient = recipientDmRelays.filter(::isAcceptedRelayUrl).map(RelayPool::normalize).distinct().filter { it !in defaultSet }
        return (recipient.take(maxOf(0, Relays.MAX_DM_RELAYS - safeDefaults.size)) + safeDefaults).distinct()
    }

    // ── Sending ─────────────────────────────────────────────────────────────

    data class Outgoing(val rumorId: String, val createdAt: Long, val toRecipient: NostrEvent, val toSelf: NostrEvent)

    /** Both copies carry one byte-identical rumor; each is sealed and wrapped separately. */
    suspend fun wrapDm(signer: NostrSigner, recipient: String, text: String, now: Long = nowSec()): Outgoing {
        val rumor = GiftWrap.rumor(signer.pubkey, Kinds.DM, text, listOf(listOf("p", recipient)), now)
        val toRecipient = GiftWrap.wrap(signer, recipient, rumor)
        val toSelf = GiftWrap.wrap(signer, signer.pubkey, rumor)
        return Outgoing(rumor.id, now, toRecipient, toSelf)
    }

    /** `since` for the steady-state scan: wide overlap with the last one (dm.ts scanDmGiftWraps). */
    fun steadySince(state: DmScanState, now: Long): Long =
        state.lastScan?.let { minOf(GiftWrap.since(now), it - 24 * 3600) } ?: GiftWrap.since(now)

    /**
     * The next history cursor after a full page whose oldest wrap is [oldest]
     * (`until` is inclusive; a relay repeating the same boundary page is forced back a second).
     */
    fun nextHistoryUntil(current: Long?, oldest: Long): Long =
        if (current != null && oldest >= current) current - 1 else oldest

    // ── Read state ──────────────────────────────────────────────────────────

    fun compare(a: DmReadPosition, b: DmReadPosition): Int = when {
        a.at != b.at -> a.at.compareTo(b.at)
        else -> a.id.compareTo(b.id)
    }

    private fun DmMessage.position() = DmReadPosition(at, id)

    /** Per-peer maximum: commutative and monotone, so devices converge whatever order writes land in. */
    fun mergeWatermarks(a: Watermarks, b: Watermarks): Watermarks {
        val merged = LinkedHashMap(a)
        for ((peer, p) in b) {
            val mine = merged[peer]
            if (mine == null || compare(p, mine) > 0) merged[peer] = p
        }
        return merged
    }

    fun sameWatermarks(a: Watermarks, b: Watermarks): Boolean =
        a.size == b.size && a.all { (peer, p) -> b[peer]?.let { compare(p, it) == 0 } == true }

    private fun newest(messages: List<DmMessage>, peer: String, pick: (DmMessage) -> Boolean): DmReadPosition? {
        var best: DmReadPosition? = null
        for (m in messages) {
            if (m.peer != peer || !pick(m)) continue
            val p = m.position()
            if (best == null || compare(p, best) > 0) best = p
        }
        return best
    }

    fun newestIncoming(messages: List<DmMessage>, owner: String, peer: String) = newest(messages, peer) { it.from != owner }

    /** Replying is reading: the stored watermark or the owner's own newest message, whichever is later. Derived, never stored. */
    fun effectiveWatermark(messages: List<DmMessage>, owner: String, peer: String, stored: DmReadPosition?): DmReadPosition? {
        val mine = newest(messages, peer) { it.from == owner } ?: return stored
        if (stored == null) return mine
        return if (compare(mine, stored) > 0) mine else stored
    }

    fun incomingUnreadCount(messages: List<DmMessage>, owner: String, peer: String? = null, watermark: DmReadPosition? = null): Int =
        messages.count { m -> m.from != owner && (peer == null || m.peer == peer) && (watermark == null || compare(m.position(), watermark) > 0) }

    fun threadUnread(messages: List<DmMessage>, owner: String, peer: String, watermarks: Watermarks): Int =
        incomingUnreadCount(messages, owner, peer, effectiveWatermark(messages, owner, peer, watermarks[peer]))

    /** Every peer's unread count, from plaintext already on the phone. */
    fun unreadByPeer(messages: List<DmMessage>, owner: String, watermarks: Watermarks): Map<String, Int> {
        val byPeer = messages.groupBy { it.peer }
        return byPeer.mapValues { (peer, list) -> threadUnread(list, owner, peer, watermarks) }.filterValues { it > 0 }
    }

    /** Advance one thread to its newest incoming message; null when nothing moved. */
    fun markThreadRead(watermarks: Watermarks, messages: List<DmMessage>, owner: String, peer: String): Watermarks? {
        val n = newestIncoming(messages, owner, peer) ?: return null
        val prior = watermarks[peer]
        if (prior != null && compare(n, prior) <= 0) return null
        return watermarks + (peer to n)
    }

    /** "Mark all as read" in one write; idempotent and never moves a watermark back. */
    fun markAllRead(watermarks: Watermarks, messages: List<DmMessage>, owner: String): Watermarks? {
        val next = LinkedHashMap(watermarks)
        var changed = false
        for (peer in messages.filter { it.from != owner }.map { it.peer }.toSet()) {
            val n = newestIncoming(messages, owner, peer) ?: continue
            val prior = next[peer]
            if (prior != null && compare(n, prior) <= 0) continue
            next[peer] = n
            changed = true
        }
        return if (changed) next else null
    }

    /** Sanitized and capped to the most recently read [Limits.MAX_DM_READ_THREADS] (dm-read-state.ts prunedForPublish). */
    fun prunedForPublish(watermarks: Watermarks): Watermarks {
        val clean = watermarks.filter { (peer, p) -> peer.isHex32() && p.id.isHex32() && p.at >= 0 }
        if (clean.size <= Limits.MAX_DM_READ_THREADS) return clean
        return clean.entries.sortedByDescending { it.value.at }.take(Limits.MAX_DM_READ_THREADS).associate { it.key to it.value }
    }

    /** Fold a scan's wrap ids into the activity ledger (dm-unread.svelte.ts observeEncryptedWrapIds). */
    fun observeActivity(a: DmActivity, ids: Collection<String>): DmActivity {
        val known = LinkedHashSet(a.known)
        val pending = LinkedHashSet(a.pending)
        for (id in ids) {
            if (a.initialized && id !in known) pending += id
            known += id
        }
        val kept = known.toList().takeLast(MAX_WRAP_IDS)
        val keptSet = kept.toSet()
        return DmActivity(true, kept, pending.filter { it in keptSet })
    }
}
