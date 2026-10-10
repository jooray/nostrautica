package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.AppPrefs
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.KeyGrantContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.OrganizerGrantContent
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.signer.silently

/** The outcome of a bounded scan (events/scan-budget.ts): what Home says about a partial answer. */
data class ScanOutcome(
    var attempted: Int = 0,
    var succeeded: Int = 0,
    var truncated: Boolean = false,
    var unreachableEvents: Int = 0,
    var newerProtocol: Boolean = false,
)

/**
 * Key grants (events/attendee.ts receiveGrants): scan the gift wraps addressed to
 * the user for 21602 key grants, 21605 organizer grants and 21606 status, and
 * apply the ones that authenticate against the event's live signed config.
 *
 * Kept from the PWA because each one was a real failure there:
 * - a per-wrap memo, written only after a DEFINITIVE outcome, so a remote signer
 *   is never asked to unwrap the same wrap twice — and a transient failure or a
 *   config we couldn't fetch is never memoized;
 * - a full-history backfill at most weekly, latched only when the read was
 *   complete, non-empty, and the signer could actually unwrap;
 * - a budget on signer round trips, so a big inbox can't become a prompt storm;
 * - a newer-protocol grant is left unmemoized for the updated build to read.
 */
class Grants(
    private val nostr: Nostr,
    private val cache: Cache,
    private val keys: EventKeysStore,
    private val contexts: EventContexts,
    private val accounts: Accounts,
    private val prefs: AppPrefs,
) {
    @Serializable
    data class MemoEntry(val coordinate: String? = null, val versions: List<Int> = emptyList(), val organizer: Boolean = false, val done: Boolean = false)

    private val lock = Mutex()

    private fun satisfied(e: MemoEntry?, held: List<EventKeys>): Boolean {
        if (e == null) return false
        if (e.done && e.coordinate == null) return true
        val k = held.firstOrNull { it.coordinate == e.coordinate } ?: return false
        return e.versions.all { id -> k.eck.any { it.id == id } } && (!e.organizer || k.isOrganizer)
    }

    private suspend fun scanRelays(pubkey: String, held: List<EventKeys>): List<String> {
        val hints = held.flatMap { contexts.relayHints(it.coordinate) }
        return (Relays.DEFAULT + accounts.inboxRelays(pubkey) + hints).map(RelayPool::normalize).distinct()
    }

    /** Page back through 1059s `#p` = me (newest first). */
    private suspend fun readWraps(pubkey: String, relays: List<String>, since: Long): Pair<List<NostrEvent>, Boolean> {
        val seen = LinkedHashMap<String, NostrEvent>()
        var until: Long? = null
        repeat(MAX_PAGES) {
            val r = nostr.pool.fetch(relays, listOf(Filter(kinds = listOf(Kinds.GIFT_WRAP), tags = mapOf("p" to listOf(pubkey)), since = since, until = until, limit = PAGE_SIZE)))
            var added = 0
            var oldest: Long? = null
            for (w in r.events) {
                if (seen.put(w.id, w) == null) added++
                if (oldest == null || w.createdAt < oldest!!) oldest = w.createdAt
            }
            if (r.events.size < PAGE_SIZE) return seen.values.toList() to (r.answered > 0)
            if (added == 0 || oldest == null) return seen.values.toList() to false
            until = oldest
        }
        return seen.values.toList() to false
    }

    fun authenticateKeyGrant(rumor: Rumor, grant: KeyGrantContent, config: EventConfig?): Boolean {
        val c = Coordinate.parseOrNull(grant.a)?.takeIf { it.isSpace } ?: return false
        if (config == null) return false
        val authorized = rumor.pubkey == c.pubkey || (config.coordinator != null && rumor.pubkey == config.coordinator)
        return authorized && grant.grantedBy == rumor.pubkey
    }

    fun authenticateOrganizerGrant(rumor: Rumor, grant: OrganizerGrantContent, config: EventConfig?): Boolean {
        val c = Coordinate.parseOrNull(grant.a)?.takeIf { it.isSpace } ?: return false
        if (rumor.pubkey != c.pubkey || grant.grantedBy != rumor.pubkey) return false
        return runCatching {
            Secp.pubkeyHex(Bytes.fromHex(grant.eidNsec)) == c.pubkey &&
                (config == null || Secp.pubkeyHex(Bytes.fromHex(grant.einboxNsec)) == config.inbox)
        }.getOrDefault(false)
    }

    /**
     * Returns the coordinates that gained keys. [force] = "Search my whole history".
     * [maxUnwraps] bounds signer round trips (each wrap costs two on a remote signer).
     */
    suspend fun receive(signer: NostrSigner, force: Boolean = false, maxUnwraps: Int = 60, outcome: ScanOutcome = ScanOutcome(), interactive: Boolean = true): Set<String> = lock.withLock {
        val pubkey = signer.pubkey
        val held = keys.list(pubkey)
        val last = prefs.getLong("grants-backfilled:$pubkey").takeIf { it > 0 }
        val backfillExpired = last == null || System.currentTimeMillis() - last >= BACKFILL_TTL_MS
        val full = force || backfillExpired || held.isEmpty()
        val relays = scanRelays(pubkey, held)
        val since = if (full) 0 else nowSec() - LOOKBACK_SEC
        val (wraps, complete) = readWraps(pubkey, relays, since)
        if (!complete) outcome.truncated = true
        nostr.store.put(wraps)

        val memoSer = MapSerializer(String.serializer(), MemoEntry.serializer())
        val memo = LinkedHashMap(cache.get(pubkey, MEMO_KEY, memoSer) ?: emptyMap())
        var dirty = false
        val configs = HashMap<String, EventConfig?>()
        suspend fun configFor(coordinate: String, extra: List<String> = emptyList()) =
            configs.getOrPut(coordinate) { runCatching { contexts.fetchConfig(coordinate, extra) }.getOrNull() }
        val gained = LinkedHashSet<String>()
        var unwrapped = 0
        var failed = 0
        var budget = maxUnwraps
        val heldNow = { keys.list(pubkey) }

        for (wrap in wraps.sortedByDescending { it.createdAt }) {
            if (wrap.tags.none { it.size >= 2 && it[0] == "p" && it[1] == pubkey }) continue
            if (satisfied(memo[wrap.id], heldNow())) continue
            if (!signer.isLocal && budget-- <= 0) { outcome.truncated = true; break }
            outcome.attempted++
            val rumor = try {
                (if (signer.isLocal || interactive) accounts.unwrap(wrap, Kinds.ATTENDEE_RUMOR_KINDS + Kinds.ORGANIZER_RUMOR_KINDS)
                    else silently { accounts.unwrap(wrap, Kinds.ATTENDEE_RUMOR_KINDS + Kinds.ORGANIZER_RUMOR_KINDS) }).also { unwrapped++; outcome.succeeded++ }
            } catch (e: GiftWrap.UnwrapException) {
                // A definitively foreign or malformed wrap (wrong kind for this key, forged seal).
                memo[wrap.id] = MemoEntry(done = true); dirty = true; continue
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: today.cypherpunk.nostrautica.signer.SignerNeedsUser) {
                // A remote signer would have to ask the user. Grants found while
                // the user is waiting for them come from the Join/Overview screens,
                // which call receive() interactively; a background scan stops here.
                outcome.truncated = true; break
            } catch (e: Exception) {
                failed++; continue // transient: not memoized, retried next scan
            }
            when (rumor.kind) {
                Kinds.ORGANIZER_GRANT -> {
                    when (val p = Wire.parseSafe(OrganizerGrantContent.serializer(), rumor.content)) {
                        is Wire.Result.Newer -> { outcome.newerProtocol = true }
                        is Wire.Result.Invalid -> { memo[wrap.id] = MemoEntry(done = true); dirty = true }
                        is Wire.Result.Ok -> {
                            val g = p.value
                            val config = configFor(g.a, g.configRelays)
                            if (!authenticateOrganizerGrant(rumor, g, config)) {
                                memo[wrap.id] = MemoEntry(done = true); dirty = true
                            } else {
                                keys.applyOrganizerGrant(pubkey, g.a, g.eck, g.eidNsec, g.einboxNsec)
                                gained += g.a
                                memo[wrap.id] = MemoEntry(g.a, g.eck.map { it.id }, organizer = true); dirty = true
                            }
                        }
                    }
                }
                Kinds.KEY_GRANT -> {
                    when (val p = Wire.parseSafe(KeyGrantContent.serializer(), rumor.content)) {
                        is Wire.Result.Newer -> { outcome.newerProtocol = true }
                        is Wire.Result.Invalid -> { memo[wrap.id] = MemoEntry(done = true); dirty = true }
                        is Wire.Result.Ok -> {
                            val g = p.value
                            val config = configFor(g.a)
                            if (config == null) {
                                outcome.unreachableEvents++ // can't authenticate yet; retried next scan
                            } else if (!authenticateKeyGrant(rumor, g, config)) {
                                memo[wrap.id] = MemoEntry(done = true); dirty = true
                            } else {
                                keys.addEckVersions(pubkey, g.a, g.eck, if (g.role == "organizer") "organizer" else "attendee")
                                gained += g.a
                                memo[wrap.id] = MemoEntry(g.a, g.eck.map { it.id }); dirty = true
                            }
                        }
                    }
                }
                Kinds.COORDINATOR_STATUS -> {
                    recordOwnStatus(rumor, pubkey) { configFor(it)?.coordinator }
                    memo[wrap.id] = MemoEntry(done = true); dirty = true
                }
                else -> { memo[wrap.id] = MemoEntry(done = true); dirty = true }
            }
        }
        if (full && complete && wraps.isNotEmpty() && !outcome.truncated && (unwrapped > 0 || failed == 0)) {
            prefs.putLong("grants-backfilled:$pubkey", System.currentTimeMillis())
        }
        if (dirty) {
            while (memo.size > MAX_MEMO) memo.remove(memo.keys.first())
            cache.put(pubkey, MEMO_KEY, memoSer, memo, nowSec())
        }
        gained
    }

    /** 21606 to this attendee about their own pipeline items (attendee-status.ts), latest per stage. */
    private suspend fun recordOwnStatus(rumor: Rumor, me: String, coordinatorOf: suspend (String) -> String?) {
        val s = (Wire.parseSafe(CoordinatorStatusContent.serializer(), rumor.content) as? Wire.Result.Ok)?.value ?: return
        if (s.pubkey != null && s.pubkey != me) return
        if (coordinatorOf(s.a) != rumor.pubkey) return
        val key = "ownstatus:${s.a}:${s.stage ?: ""}"
        cache.put(me, key, CoordinatorStatusContent.serializer(), s, s.at)
    }

    suspend fun ownStatuses(me: String, coordinate: String): List<CoordinatorStatusContent> =
        cache.prefix(me, "ownstatus:$coordinate:", CoordinatorStatusContent.serializer()).values.toList()

    companion object {
        const val PAGE_SIZE = 500
        const val MAX_PAGES = 20
        const val MAX_MEMO = 5000
        const val MEMO_KEY = "grantwraps-v2"
        const val BACKFILL_TTL_MS = 7L * 24 * 3600 * 1000
        val LOOKBACK_SEC = BACKFILL_TTL_MS / 1000 + GiftWrap.MAX_BACKDATE_SEC + 24 * 3600
    }
}
