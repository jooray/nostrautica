package today.cypherpunk.nostrautica.protocol

/**
 * Latest-event rule (NIP §3.1): higher `created_at` wins; on a tie the
 * lexicographically lowest id wins. Every reader applies exactly this, so two
 * implementations never disagree about which replaceable event is current.
 */
object Ordering {
    /** Negative when `a` is the current one (sorts first). */
    fun compareLatest(aId: String, aCreated: Long, bId: String, bCreated: Long): Int = when {
        aCreated != bCreated -> bCreated.compareTo(aCreated)
        else -> aId.compareTo(bId)
    }

    fun supersedes(candidate: NostrEvent, current: NostrEvent): Boolean =
        compareLatest(candidate.id, candidate.createdAt, current.id, current.createdAt) < 0

    fun <T> pickLatest(events: Iterable<T>, id: (T) -> String, createdAt: (T) -> Long): T? {
        var best: T? = null
        for (e in events) {
            val b = best
            if (b == null || compareLatest(id(e), createdAt(e), id(b), createdAt(b)) < 0) best = e
        }
        return best
    }

    fun pickLatest(events: Iterable<NostrEvent>): NostrEvent? = pickLatest(events, { it.id }, { it.createdAt })

    /** §3.3: higher rev, then higher created_at, then lowest rumor id. */
    data class RevisionKey(val rev: Long, val createdAt: Long, val id: String)

    fun revisionSupersedes(candidate: RevisionKey, current: RevisionKey): Boolean = when {
        candidate.rev != current.rev -> candidate.rev > current.rev
        candidate.createdAt != current.createdAt -> candidate.createdAt > current.createdAt
        else -> candidate.id < current.id
    }
}
