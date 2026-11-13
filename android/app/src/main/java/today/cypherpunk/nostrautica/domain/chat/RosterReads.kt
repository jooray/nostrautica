package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.protocol.RosterContent
import java.util.concurrent.ConcurrentHashMap

/**
 * Roster reads for the chat, with the provenance an attest decision needs (audit
 * KIMIK31 A-3).
 *
 * A roster is FRESH only when a relay sent it in the read that returned it
 * ([Members.RosterRead.fromNetwork]), or it is the memo of such a read under
 * `reuseMs` old. A store-only read (offline, every relay silent) still comes back,
 * so the screen can show it, but stamped not-fresh: it may predate this device's
 * attestation, and as "fresh" it used to read as "the roster does not list you",
 * which discarded an attested device key or attested again (a re-enrolment, i.e. a
 * kick and re-add).
 */
class RosterReads(private val clock: () -> Long = System::currentTimeMillis) {
    /** [atMs]: when the relays sent it (fresh), or when it was read from the phone (not fresh). */
    data class Fetched(val roster: RosterContent, val atMs: Long, val fresh: Boolean)

    /** The last FRESH roster with attendees per key, and when it was fetched, in this process. */
    private val memo = ConcurrentHashMap<String, Pair<Long, RosterContent>>()

    suspend fun fetch(key: String, reuseMs: Long, read: suspend () -> Members.RosterRead?): Fetched? {
        val now = clock()
        memo[key]?.let { (at, r) -> if (reuseMs > 0 && now - at < reuseMs) return Fetched(r, at, true) }
        val r = read() ?: return null
        // An empty roster is what the read returns when no copy exists anywhere: never fresh.
        val fresh = r.fromNetwork && r.roster.attendees.isNotEmpty()
        if (fresh) memo[key] = now to r.roster
        return Fetched(r.roster, now, fresh)
    }
}
