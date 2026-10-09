package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.RosterContent

/** An invite proof carried on a 21600 `invite` tag. */
@Serializable
data class InviteProofRef(val invitePubkey: String, val sig: String)

/**
 * One person's latest intake from E_inbox (organizer.ts PendingRequest): their join
 * request, folded with their newest profile submission, and whether a newer 21610
 * withdrawal supersedes the join.
 */
@Serializable
data class PendingRequest(
    val attendeePubkey: String,
    val name: String,
    val message: String = "",
    val rsvpPublic: Boolean = false,
    val profile: AttendeeProfile? = null,
    val media: List<MediaDescriptor>? = null,
    val introText: String? = null,
    val invite: InviteProofRef? = null,
    val rumorCreatedAt: Long,
    val withdrawn: Boolean = false,
    val withdrawalRequestedPurge: Boolean = false,
)

/** admin-people.ts: the pure derivations behind the Admin queue and People list. */
object AdminModel {
    /**
     * Merge a fresh (possibly partial) relay scan INTO the known queue (UX-A2): a
     * request already seen is never dropped by its absence; the newer per person wins.
     */
    fun mergePending(known: List<PendingRequest>, fresh: List<PendingRequest>): List<PendingRequest> {
        val by = LinkedHashMap<String, PendingRequest>()
        known.forEach { by[it.attendeePubkey] = it }
        for (r in fresh) {
            val prev = by[r.attendeePubkey]
            if (prev == null || r.rumorCreatedAt >= prev.rumorCreatedAt) by[r.attendeePubkey] = r
        }
        return by.values.sortedBy { it.rumorCreatedAt }
    }

    fun visiblePending(known: List<PendingRequest>, isApproved: (String) -> Boolean, revoked: Set<String>, rejected: Set<String> = emptySet()) =
        known.filter { !isApproved(it.attendeePubkey) && it.attendeePubkey !in revoked && it.attendeePubkey !in rejected }

    enum class Op { OK, PROCESSING, FAILED }

    data class Person(
        val pubkey: String,
        val role: String,
        val name: String?,
        val intakeAvailable: Boolean,
        val profile: AttendeeProfile?,
        val media: List<MediaDescriptor>?,
        val introText: String?,
        val hasIntro: Boolean,
        val op: Op,
        val revoked: Boolean,
        val inRoster: Boolean,
        val withdrawn: Boolean,
        val withdrawalRequestedPurge: Boolean,
    )

    private fun opFor(pubkey: String, statuses: List<CoordinatorStatusContent>?): Op =
        if (statuses?.any { it.pubkey == pubkey && it.state == "poison" } == true) Op.FAILED else Op.OK

    /** Approved people enumerated from the durable roster (UX-A1), enriched with intake + directory. */
    fun buildApprovedPeople(
        roster: RosterContent?,
        sessionApproved: Set<String>,
        revoked: Set<String>,
        known: List<PendingRequest>,
        directory: List<DirectoryEntryContent>? = null,
        statuses: List<CoordinatorStatusContent>? = null,
    ): List<Person> {
        val rosterBy = roster?.attendees?.associateBy { it.pubkey } ?: emptyMap()
        val pendingBy = known.associateBy { it.attendeePubkey }
        val dirBy = directory?.associateBy { it.pubkey } ?: emptyMap()
        val order = LinkedHashSet<String>()
        roster?.attendees?.forEach { order += it.pubkey }
        order += sessionApproved
        order += revoked
        return order.map { pk ->
            val req = pendingBy[pk]
            val dir = dirBy[pk]
            val media = dir?.media ?: req?.media
            val intro = dir?.introText ?: req?.introText
            Person(
                pubkey = pk,
                role = rosterBy[pk]?.role ?: "attendee",
                name = dir?.name ?: req?.name,
                intakeAvailable = req != null || dir != null,
                profile = dir?.profile ?: req?.profile,
                media = media,
                introText = intro,
                hasIntro = !media.isNullOrEmpty() || !intro.isNullOrBlank(),
                op = opFor(pk, statuses),
                revoked = pk in revoked,
                inRoster = pk in rosterBy,
                withdrawn = req?.withdrawn == true,
                withdrawalRequestedPurge = req?.withdrawalRequestedPurge == true,
            )
        }
    }

    enum class BulkState { QUEUED, PUBLISHING, CONFIRMED, FAILED }
    data class BulkItem(val pubkey: String, val state: BulkState, val error: String? = null)
    data class BulkSummary(val approved: Int, val needRetry: Int, val done: Boolean)

    fun summarizeBulk(items: Iterable<BulkItem>): BulkSummary {
        var ok = 0; var retry = 0; var work = false
        for (it in items) when (it.state) {
            BulkState.CONFIRMED -> ok++
            BulkState.FAILED -> retry++
            else -> work = true
        }
        return BulkSummary(ok, retry, !work)
    }

    enum class Filter(val key: String) {
        ALL("admin.people.filter.all"), PENDING("admin.people.filter.pending"), APPROVED("admin.people.filter.approved"),
        NO_INTRO("admin.people.filter.noIntro"), FAILED("admin.people.filter.failed"), TALK("admin.people.filter.talk"),
    }

    data class Filterable(val pubkey: String, val name: String?, val approved: Boolean, val hasIntro: Boolean, val op: Op, val hasTalk: Boolean)

    fun filterPeople(people: List<Filterable>, filter: Filter, query: String): List<Filterable> {
        val q = query.trim().lowercase()
        return people.filter { p ->
            if (q.isNotEmpty() && !((p.name?.lowercase()?.contains(q) == true) || p.pubkey.lowercase().contains(q))) return@filter false
            when (filter) {
                Filter.PENDING -> !p.approved
                Filter.APPROVED -> p.approved
                Filter.NO_INTRO -> p.approved && !p.hasIntro
                Filter.FAILED -> p.op == Op.FAILED
                Filter.TALK -> p.hasTalk
                Filter.ALL -> true
            }
        }
    }

    // ── Overview (admin-overview.ts) ─────────────────────────────────────────

    enum class Tone { OK, WARN, NEUTRAL }

    /** [value] is a number, or a catalog key for a word ("admin.overview.yes"). */
    data class Metric(val id: String, val labelKey: String, val value: String, val valueIsKey: Boolean, val tone: Tone, val exception: Boolean)

    data class OverviewInput(
        val pendingCount: Int,
        val approvedCount: Int,
        val missingIntros: Int,
        val failedJobs: Int,
        val talksAwaiting: Int,
        val matchesAvailable: Boolean,
        val hasCoordinator: Boolean,
        val coordinatorUnknown: Boolean,
        val billingBlocked: Boolean,
    )

    fun buildOverview(i: OverviewInput): Pair<List<Metric>, List<Metric>> {
        val all = mutableListOf<Metric>()
        if (i.failedJobs > 0) all += Metric("failedJobs", "admin.overview.failedJobs", "${i.failedJobs}", false, Tone.WARN, true)
        if (i.hasCoordinator && i.billingBlocked) all += Metric("billing", "admin.overview.billing", "admin.overview.billing.blocked", true, Tone.WARN, true)
        all += Metric("pending", "admin.overview.pending", "${i.pendingCount}", false, if (i.pendingCount > 0) Tone.WARN else Tone.OK, false)
        all += Metric("approved", "admin.overview.approved", "${i.approvedCount}", false, Tone.NEUTRAL, false)
        all += Metric("missingIntros", "admin.overview.missingIntros", "${i.missingIntros}", false, if (i.missingIntros > 0) Tone.NEUTRAL else Tone.OK, false)
        if (i.hasCoordinator) {
            all += Metric("talksAwaiting", "admin.overview.talksAwaiting", "${i.talksAwaiting}", false, if (i.talksAwaiting > 0) Tone.WARN else Tone.OK, false)
            all += Metric("matches", "admin.overview.matches", if (i.matchesAvailable) "admin.overview.yes" else "admin.overview.no", true, Tone.NEUTRAL, false)
            all += Metric(
                "coordinator", "admin.overview.coordinator",
                if (i.coordinatorUnknown) "admin.overview.coord.unknown" else "admin.overview.coord.ok", true,
                if (i.coordinatorUnknown) Tone.WARN else Tone.OK, false,
            )
        }
        return all.filter { it.exception } to all.filterNot { it.exception }
    }

    // ── Person drawer (admin-person-detail.ts) ───────────────────────────────

    data class TimelineEntry(val labelKey: String, val tone: Tone, val at: Long?, val detail: String?)

    fun introKind(media: List<MediaDescriptor>?, introText: String?): String {
        val intro = media?.firstOrNull { it.kind == "intro" }
        if (intro != null) return if (intro.m.startsWith("audio/")) "audio" else "video"
        return if (!introText.isNullOrBlank()) "text" else "none"
    }

    fun membership(revoked: Boolean, review: String?, inRoster: Boolean, pending: Boolean): String = when {
        revoked -> "revoked"
        review == "rejected" -> "rejected"
        review == "deferred" -> "deferred"
        inRoster -> "approved"
        pending -> "pending"
        else -> "approved"
    }

    fun timeline(statuses: List<CoordinatorStatusContent>, talks: List<Pair<String, String>>): List<TimelineEntry> {
        val out = mutableListOf<TimelineEntry>()
        for (s in statuses) {
            val key = when (s.state) { "poison" -> "admin.person.event.failed"; "cleared" -> "admin.person.event.recovered"; else -> null } ?: continue
            out += TimelineEntry(key, if (s.state == "poison") Tone.WARN else Tone.OK, s.at, s.stage ?: s.errorCategory)
        }
        for ((title, status) in talks) {
            val key = when (status) { "published" -> "admin.person.talk.published"; "rejected" -> "admin.person.talk.rejected"; else -> "admin.person.talk.pending" }
            out += TimelineEntry(key, when (status) { "rejected" -> Tone.WARN; "published" -> Tone.OK; else -> Tone.NEUTRAL }, null, title)
        }
        return out.sortedByDescending { it.at ?: 0 }
    }

    // ── Coordinator statuses (coordinator-status.ts) ─────────────────────────

    /** Newest status per (stage, attendee): a later `cleared` supersedes an earlier `poison`. */
    fun dedupeLatestStatuses(statuses: List<CoordinatorStatusContent>): List<CoordinatorStatusContent> {
        val latest = LinkedHashMap<String, CoordinatorStatusContent>()
        for (s in statuses) {
            val k = "${s.stage}\u001f${s.pubkey ?: ""}"
            val prev = latest[k]
            if (prev == null || s.at > prev.at) latest[k] = s
        }
        return latest.values.toList()
    }

    fun statusId(s: CoordinatorStatusContent) = "${s.a}${s.stage}${s.pubkey ?: ""}"

    /** "active 2 min ago" labels (Admin.svelte sinceLabel): key + n. */
    fun sinceLabel(unixSec: Long, now: Long = System.currentTimeMillis() / 1000): Pair<String, Int> {
        val s = maxOf(0, now - unixSec)
        return when {
            s < 90 -> "admin.coord.justNow" to 0
            s < 3600 -> "admin.coord.minAgo" to Math.round(s / 60.0).toInt()
            s < 86400 -> "admin.coord.hAgo" to Math.round(s / 3600.0).toInt()
            else -> "admin.coord.dAgo" to Math.round(s / 86400.0).toInt()
        }
    }

    const val COORD_QUIET_AFTER_SEC = 3600L
}
