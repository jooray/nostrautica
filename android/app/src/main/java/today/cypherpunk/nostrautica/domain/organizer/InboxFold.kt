package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.JoinRequestContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.ProfileSubmissionContent
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.TalkSubmissionContent
import today.cypherpunk.nostrautica.protocol.WithdrawalContent
import today.cypherpunk.nostrautica.protocol.Wire

/** A talk submission awaiting moderation (talks.ts PendingTalk). */
@Serializable
data class PendingTalk(
    val pubkey: String,
    val talkD: String,
    val title: String,
    val description: String = "",
    val media: MediaDescriptor? = null,
    val externalUrl: String? = null,
    val externalKind: String? = null,
    val revision: Long = 0,
    val rumorCreatedAt: Long,
)

/**
 * The pure half of organizer.ts fetchPending / talks.ts fetchPendingTalks: fold the
 * rumors unwrapped from E_inbox into one request per attendee.
 *
 * - joins are ordered by the global tie-break (created_at, then lowest id), never
 *   arrival order (audit P4);
 * - submissions by (rev, created_at, lowest id), so a delayed rev 1 can't replace rev 2;
 * - a 21610 withdrawal newer than the join marks it withdrawn; one with no join in
 *   the window still surfaces as a nameless request (an attendee who joined weeks ago
 *   and withdrew today has only the withdrawal inside the 3-day window).
 */
object InboxFold {
    fun fold(rumors: List<Rumor>, coordinate: String): List<PendingRequest> {
        data class Join(val req: PendingRequest, val id: String)
        data class Sub(val key: Ordering.RevisionKey, val c: ProfileSubmissionContent)
        data class W(val id: String, val at: Long, val purge: Boolean)
        val joins = HashMap<String, Join>()
        val subs = HashMap<String, Sub>()
        val withdrawals = HashMap<String, W>()
        for (r in rumors) {
            when (r.kind) {
                Kinds.JOIN_REQUEST -> {
                    val c = (Wire.parseSafe(JoinRequestContent.serializer(), r.content) as? Wire.Result.Ok)?.value ?: continue
                    val inv = r.tags.firstOrNull { it.size >= 3 && it[0] == "invite" && it[1].isNotEmpty() && it[2].isNotEmpty() }
                        ?.let { InviteProofRef(it[1], it[2]) }
                    val prev = joins[r.pubkey]
                    if (prev == null || Ordering.compareLatest(r.id, r.createdAt, prev.id, prev.req.rumorCreatedAt) < 0) {
                        joins[r.pubkey] = Join(PendingRequest(r.pubkey, c.name, c.message, c.rsvpPublic, invite = inv, rumorCreatedAt = r.createdAt), r.id)
                    }
                }
                Kinds.ATTENDEE_WITHDRAWAL -> {
                    val c = (Wire.parseSafe(WithdrawalContent.serializer(), r.content) as? Wire.Result.Ok)?.value ?: continue
                    if (c.a != coordinate) continue
                    val prev = withdrawals[r.pubkey]
                    if (prev == null || Ordering.compareLatest(r.id, r.createdAt, prev.id, prev.at) < 0) withdrawals[r.pubkey] = W(r.id, r.createdAt, c.deleteData)
                }
                Kinds.PROFILE_SUBMISSION -> {
                    val c = (Wire.parseSafe(ProfileSubmissionContent.serializer(), r.content) as? Wire.Result.Ok)?.value ?: continue
                    val key = Ordering.RevisionKey(c.rev, r.createdAt, r.id)
                    val prev = subs[r.pubkey]
                    if (prev == null || Ordering.revisionSupersedes(key, prev.key)) subs[r.pubkey] = Sub(key, c)
                }
            }
        }
        val by = LinkedHashMap<String, PendingRequest>()
        val joinIds = HashMap<String, String>()
        for ((pk, j) in joins) {
            val s = subs[pk]?.c
            by[pk] = if (s != null) j.req.copy(profile = s.profile, media = s.media, introText = s.introText) else j.req
            joinIds[pk] = j.id
        }
        for ((pk, w) in withdrawals) {
            val req = by[pk]
            if (req == null) {
                by[pk] = PendingRequest(pk, "", rumorCreatedAt = w.at, withdrawn = true, withdrawalRequestedPurge = w.purge)
                continue
            }
            if (Ordering.compareLatest(w.id, w.at, joinIds[pk] ?: "", req.rumorCreatedAt) < 0) {
                by[pk] = req.copy(withdrawn = true, withdrawalRequestedPurge = w.purge)
            }
        }
        return by.values.sortedBy { it.rumorCreatedAt }
    }

    /** talks.ts dedupePendingTalks: newest per (speaker, talk_d), minus already-published revisions. */
    fun pendingTalks(rumors: List<Rumor>, coordinate: String, publishedRev: Map<String, Long>): List<PendingTalk> {
        val latest = HashMap<String, PendingTalk>()
        for (r in rumors) {
            if (r.kind != Kinds.TALK_SUBMISSION) continue
            val c = (Wire.parseSafe(TalkSubmissionContent.serializer(), r.content) as? Wire.Result.Ok)?.value ?: continue
            if (c.a != coordinate) continue
            val key = "${r.pubkey}:${c.talkD}"
            val prev = latest[key]
            if (prev == null || r.createdAt > prev.rumorCreatedAt) {
                latest[key] = PendingTalk(r.pubkey, c.talkD, c.title, c.description, c.media, c.externalUrl, c.externalKind, c.revision, r.createdAt)
            }
        }
        return latest.values.filter { (publishedRev["${it.pubkey}:${it.talkD}"] ?: -1) < it.revision }.sortedBy { it.rumorCreatedAt }
    }
}
