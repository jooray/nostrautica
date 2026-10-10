package today.cypherpunk.nostrautica.domain.content

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.TalkContent
import today.cypherpunk.nostrautica.protocol.Wire

/** A published talk with the blinded `d` that addresses its detail route (talks.ts TalkItem). */
@Serializable
data class TalkItem(val talk: TalkContent, val d: String)

object TalkLogic {
    /** [sawAny]: some trusted 31610 existed at all — evidence, unlike an empty answer, that an empty set is real. */
    data class Decoded(val items: List<TalkItem>, val newerSeen: Boolean, val newestAt: Long, val sawAny: Boolean)

    /**
     * Decrypt the 31610s of an event into its published talks, newest first.
     *
     * - Record authority (NIP §3.7): only [authors] (the CURRENT coordinator and
     *   E_id) count; a formerly assigned coordinator's talks are ignored.
     * - NIP-09: talks the coordinator deleted (a rejection) are gone.
     * - Each event decrypts with the ECK version its `eck` tag names (falling
     *   back to the newest held), and its `d` must be the blinded address that
     *   key derives for (speaker, talk_d), so content can't sit at an address it
     *   doesn't belong to.
     * - After an ECK rotation the coordinator republishes a talk at a NEW blinded
     *   `d`; the same (speaker, talk_d) is then kept once, at the highest
     *   revision (then newest event).
     */
    fun decode(coordinate: String, authors: List<String>, events: List<NostrEvent>, deletions: List<NostrEvent>, eck: List<EckVersion>): Decoded {
        val trusted = events.filter { it.kind == Kinds.TALK && it.pubkey in authors && it.d != null }
        val live = PostLogic.applyDeletions(trusted, deletions.filter { it.pubkey in authors })
        val latestByD = live.groupBy { it.d!! }.mapNotNull { (_, v) -> Ordering.pickLatest(v) }
        val newestKey = eck.maxByOrNull { it.id }
        var newer = false
        var newestAt = 0L
        val best = LinkedHashMap<String, Pair<TalkItem, NostrEvent>>()
        for (e in latestByD) {
            val key = e.tag("eck")?.toIntOrNull()?.let { id -> eck.firstOrNull { it.id == id } } ?: newestKey ?: continue
            val bytes = key.bytes()
            val talk = when (val r = runCatching { Wire.parseSafe(TalkContent.serializer(), Nip44.eckDecrypt(bytes, e.content)) }.getOrNull()) {
                is Wire.Result.Ok -> r.value
                is Wire.Result.Newer -> { newer = true; null }
                else -> null
            } ?: continue
            newestAt = maxOf(newestAt, e.createdAt)
            if (ProtocolCrypto.talkD(bytes, coordinate, talk.pubkey, talk.talkD) != e.d) continue
            if (talk.status != "published") continue
            val id = "${talk.pubkey}:${talk.talkD}"
            val prev = best[id]
            if (prev == null || talk.revision > prev.first.talk.revision ||
                (talk.revision == prev.first.talk.revision && Ordering.supersedes(e, prev.second))
            ) best[id] = TalkItem(talk, e.d!!) to e
        }
        return Decoded(best.values.map { it.first }.sortedByDescending { it.talk.publishedAt }, newer, newestAt, trusted.isNotEmpty())
    }

    /**
     * The "an empty relay answer can't blank a talk already seen" rule
     * (talks.ts): a non-empty fresh set wins; an empty one keeps a non-empty
     * prior unless there is evidence (trusted 31610s that were all deleted,
     * rejected or superseded) that the event really has none now.
     */
    fun merge(prior: List<TalkItem>?, fresh: Decoded): List<TalkItem> =
        if (fresh.items.isEmpty() && !fresh.sawAny && !prior.isNullOrEmpty()) prior else fresh.items

}
