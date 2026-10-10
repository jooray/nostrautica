package today.cypherpunk.nostrautica.domain.media

import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.protocol.nowSec

/**
 * The persisted per-event revision high-water marks (submit.ts nextRev /
 * claimCorrectionRev, NIP §3.3), owner-scoped.
 *
 * Persisted rather than re-derived from relays on every submit: an empty relay
 * read (venue Wi-Fi) used to restart the counter at 0, the coordinator discarded
 * the "stale" submission, and the attendee was told it had saved. A failed read
 * can now only fail to ADVANCE the counter, never roll it back.
 *
 * Stamped with the WALL clock, never the counter itself: a rev of 3 read as a
 * cache timestamp is 1970, and the 30-day prune would delete the mark on the
 * next start.
 */
class RevCounters(private val cache: Cache) {
    private fun revKey(c: String) = "selfrev:$c"
    private fun corrKey(c: String) = "corrrev:$c"

    suspend fun floor(owner: String, coordinate: String, observed: Long?): Long =
        maxOf(cache.get(owner, revKey(coordinate), Long.serializer()) ?: -1, observed ?: -1)

    /** Strictly above everything ever sent from here and everything [observed] elsewhere. */
    suspend fun next(owner: String, coordinate: String, observed: Long?): Long {
        val n = floor(owner, coordinate, observed) + 1
        cache.put(owner, revKey(coordinate), Long.serializer(), n, nowSec())
        return n
    }

    /** Raise the mark to a rev already sent, without consuming one. */
    suspend fun raise(owner: String, coordinate: String, rev: Long) {
        cache.put(owner, revKey(coordinate), Long.serializer(), floor(owner, coordinate, rev), nowSec())
    }

    suspend fun correctionFloor(owner: String, coordinate: String): Long? = cache.get(owner, corrKey(coordinate), Long.serializer())

    suspend fun raiseCorrection(owner: String, coordinate: String, rev: Long) {
        cache.put(owner, corrKey(coordinate), Long.serializer(), maxOf(correctionFloor(owner, coordinate) ?: -1, rev), nowSec())
    }

    /** The next 21608 rev: above the local mark AND the relay-backed self-copy's (audit A-5). */
    suspend fun claimCorrection(owner: String, coordinate: String, observed: Long?): Long {
        val n = maxOf(correctionFloor(owner, coordinate) ?: -1, observed ?: -1) + 1
        cache.put(owner, corrKey(coordinate), Long.serializer(), n, nowSec())
        return n
    }
}
