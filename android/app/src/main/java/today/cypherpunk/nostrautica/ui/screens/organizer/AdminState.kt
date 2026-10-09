package today.cypherpunk.nostrautica.ui.screens.organizer

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.EventKeys
import today.cypherpunk.nostrautica.domain.organizer.AdminModel
import today.cypherpunk.nostrautica.domain.organizer.GeneratedInvite
import today.cypherpunk.nostrautica.domain.organizer.Invites
import today.cypherpunk.nostrautica.domain.organizer.Organizer
import today.cypherpunk.nostrautica.domain.organizer.PendingRequest
import today.cypherpunk.nostrautica.domain.organizer.PendingTalk
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.I18n
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.nowSec

/**
 * The Admin page's state and actions (pages/Admin.svelte script). Every slice paints
 * from the owner-scoped cache first, then refreshes; the join queue is a DURABLE
 * merge, never replaced by a partial scan (UX-A2).
 */
@Stable
class AdminState(private val c: AppContainer, val ctx: EventContext, private val scope: CoroutineScope, private val strings: () -> I18n.Strings) {
    private val org: Organizer = c.organizer
    val coordinate get() = ctx.coordinate
    val cfg get() = ctx.cfg

    var keys by mutableStateOf<EventKeys?>(null)
    var pending by mutableStateOf<List<PendingRequest>>(emptyList())
    var roster by mutableStateOf<RosterContent?>(null)
    var directory by mutableStateOf<List<DirectoryEntryContent>?>(null)
    var talks by mutableStateOf<List<PendingTalk>>(emptyList())
    var statuses by mutableStateOf<List<CoordinatorStatusContent>>(emptyList())
    var lastSeen by mutableStateOf<Long?>(null)
    var livenessChecked by mutableStateOf(false)
    var lastRefreshed by mutableStateOf<Long?>(null)
    var refreshing by mutableStateOf(false)
    var loading by mutableStateOf(true)
    var error by mutableStateOf<String?>(null)
    var review by mutableStateOf<Map<String, String>>(emptyMap())
    var dismissed by mutableStateOf<Set<String>>(emptySet())
    var approvedSet by mutableStateOf<Set<String>>(emptySet())
    var revokedSet by mutableStateOf<Set<String>>(emptySet())
    var approving by mutableStateOf<Set<String>>(emptySet())
    var bulk by mutableStateOf<List<AdminModel.BulkItem>>(emptyList())
    var bulkRan by mutableStateOf(false)
    var approvingAll by mutableStateOf(false)
    var moderated by mutableStateOf<Set<String>>(emptySet())
    var retryingStatus by mutableStateOf<String?>(null)
    var recomputing by mutableStateOf(false)
    var enrolling by mutableStateOf(false)
    var enrollSent by mutableStateOf(false)
    var enrollError by mutableStateOf<String?>(null)
    var invites by mutableStateOf<List<GeneratedInvite>>(emptyList())
    var sharedInvite by mutableStateOf<GeneratedInvite?>(null)
    var generating by mutableStateOf(false)
    var generatingShared by mutableStateOf(false)
    var report by mutableStateOf(Invites.Report())
    var reportBusy by mutableStateOf(false)
    var posts by mutableStateOf<List<Organizer.Post>>(emptyList())

    private val refreshLock = Mutex()
    private fun msg(e: Throwable) = e.message ?: e.toString()

    val me: String? get() = c.session.account.value?.pubkey
    val missingEid get() = keys?.eidNsecHex == null
    val selfEnrolled get() = me != null && roster?.attendees?.any { it.pubkey == me } == true

    private fun isApproved(pk: String) = pk in approvedSet || roster?.attendees?.any { it.pubkey == pk } == true
    val rejected get() = review.filterValues { it == "rejected" }.keys
    val deferred get() = review.filterValues { it == "deferred" }.keys
    val visiblePending get() = AdminModel.visiblePending(pending, ::isApproved, revokedSet, rejected)
    val visibleTalks get() = talks.filter { "${it.pubkey}:${it.talkD}" !in moderated }
    val approvedPeople get() = AdminModel.buildApprovedPeople(roster, approvedSet, revokedSet, pending, directory, statuses)
    val poison get() = statuses.filter { it.state == "poison" && AdminModel.statusId(it) !in dismissed }
    val billing get() = statuses.filter { it.billing != null && it.billing!!.state != "ok" }.maxByOrNull { it.at }?.billing

    fun overview() = AdminModel.buildOverview(AdminModel.OverviewInput(
        pendingCount = visiblePending.size,
        approvedCount = approvedPeople.count { !it.revoked },
        missingIntros = approvedPeople.count { !it.revoked && !it.hasIntro },
        failedJobs = poison.size,
        talksAwaiting = visibleTalks.size,
        matchesAvailable = cfg.matching,
        hasCoordinator = cfg.coordinator != null,
        coordinatorUnknown = lastSeen == null,
        billingBlocked = billing != null,
    ))

    suspend fun paintFromCache() {
        pending = AdminModel.mergePending(pending, org.cachedPending(coordinate))
        roster = org.cachedRoster(coordinate) ?: roster
        directory = org.cachedDirectory(coordinate).ifEmpty { directory }
        review = org.loadReview(coordinate)
        dismissed = org.loadDismissed(coordinate)
        talks = org.cachedPendingTalks(coordinate)
        statuses = org.cachedStatuses(coordinate)
        lastSeen = org.cachedLastSeen(coordinate)
        org.cachedInviteReport(coordinate)?.let { report = it }
        posts = org.cachedPosts(coordinate)
    }

    /** Pending + roster together, assigned in the same tick (so a self-request never flashes an Approve button). */
    suspend fun refresh() = refreshLock.withLock {
        val k = keys ?: return@withLock
        refreshing = true
        try {
            val (fresh, mem) = kotlinx.coroutines.coroutineScope {
                val inbox = async { org.readInbox(ctx, k) }
                val members = async { runCatching { org.refreshMembers(ctx) }.getOrNull() }
                inbox.await() to members.await()
            }

            val (r, d) = mem ?: (null to null)
            pending = AdminModel.mergePending(pending, fresh.pending)
            if (r != null) roster = r
            if (d != null) directory = d
            fresh.talks?.let { talks = it } ?: run { if (cfg.talks == "off" || cfg.coordinator == null) talks = emptyList() }
            lastRefreshed = nowSec()
            scope.launch { refreshInviteReport() }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (e !is java.io.IOException) error = msg(e)
        } finally {
            refreshing = false
        }
    }

    suspend fun refreshLiveness() {
        if (cfg.coordinator == null) return
        livenessChecked = false
        try {
            lastSeen = runCatching { org.fetchCoordinatorLastSeen(ctx) }.getOrNull() ?: lastSeen
            keys?.takeIf { it.eidNsecHex != null }?.let { k -> statuses = runCatching { org.fetchCoordinatorStatuses(ctx, k) }.getOrDefault(statuses) }
        } finally { livenessChecked = true }
    }

    suspend fun refreshInviteReport() {
        reportBusy = true
        try { runCatching { report = org.refreshInviteReport(ctx, pending) } } finally { reportBusy = false }
    }

    suspend fun refreshPosts() { posts = runCatching { org.fetchPosts(ctx) }.getOrDefault(posts) }

    fun setReview(pk: String, state: String?) = scope.launch { review = org.setReview(coordinate, review, pk, state) }

    private suspend fun approveOne(pk: String) {
        if (cfg.coordinator != null) org.sendAdminCommand(ctx, "approve", mapOf("pubkey" to pk))
        else {
            val req = pending.firstOrNull { it.attendeePubkey == pk } ?: throw IllegalStateException(strings().t("admin.reprocess.noIntake"))
            org.approve(ctx, req)
        }
        approvedSet = approvedSet + pk
    }

    fun approve(pk: String) {
        if (pk in approving) return
        approving = approving + pk
        scope.launch {
            runCatching { approveOne(pk) }.onFailure { error = msg(it) }
            approving = approving - pk
        }
    }

    private suspend fun runBulk(pk: String) {
        bulk = bulk.map { if (it.pubkey == pk) it.copy(state = AdminModel.BulkState.PUBLISHING) else it }
        val r = runCatching { approveOne(pk) }
        bulk = bulk.map { if (it.pubkey == pk) it.copy(state = if (r.isSuccess) AdminModel.BulkState.CONFIRMED else AdminModel.BulkState.FAILED, error = r.exceptionOrNull()?.message) else it }
    }

    fun approveAll() {
        approvingAll = true; bulkRan = true
        bulk = visiblePending.map { AdminModel.BulkItem(it.attendeePubkey, AdminModel.BulkState.QUEUED) }
        scope.launch {
            try { for (it in bulk.toList()) runBulk(it.pubkey) } finally { approvingAll = false }
        }
    }

    fun retryBulk(pk: String) = scope.launch { runBulk(pk) }

    fun revoke(pk: String) = scope.launch {
        runCatching {
            if (cfg.coordinator != null) org.sendAdminCommand(ctx, "revoke", mapOf("pubkey" to pk)) else org.revokeClient(ctx, pk)
            revokedSet = revokedSet + pk
            approvedSet = approvedSet - pk
        }.onFailure { error = msg(it) }
    }

    /** Without a coordinator, re-approve from a FRESH inbox read so a later text intro isn't dropped. */
    fun reprocess(pk: String) = scope.launch {
        runCatching {
            if (cfg.coordinator != null) org.sendAdminCommand(ctx, "reprocess", mapOf("pubkey" to pk))
            else {
                val fresh = org.readInbox(ctx, keys ?: return@runCatching).pending
                pending = AdminModel.mergePending(pending, fresh)
                val latest = fresh.firstOrNull { it.attendeePubkey == pk }
                if (latest == null) { error = strings().t("admin.reprocess.noIntake"); return@runCatching }
                org.approve(ctx, latest)
            }
        }.onFailure { error = msg(it) }
    }

    fun dismissStatus(s: CoordinatorStatusContent) {
        dismissed = dismissed + AdminModel.statusId(s)
        scope.launch { org.saveDismissed(coordinate, dismissed) }
    }

    fun retryStatus(s: CoordinatorStatusContent) = scope.launch {
        retryingStatus = AdminModel.statusId(s)
        runCatching {
            if (s.pubkey != null) org.sendAdminCommand(ctx, "reprocess", mapOf("pubkey" to s.pubkey!!)) else org.sendAdminCommand(ctx, "recompute")
            dismissStatus(s)
        }.onFailure { error = msg(it) }
        retryingStatus = null
    }

    fun recompute() = scope.launch {
        recomputing = true
        runCatching { org.sendAdminCommand(ctx, "recompute") }.onFailure { error = msg(it) }
        recomputing = false
    }

    fun moderate(t: PendingTalk, cmd: String) = scope.launch {
        runCatching {
            org.sendAdminCommand(ctx, cmd, mapOf("pubkey" to t.pubkey, "talk_d" to t.talkD))
            moderated = moderated + "${t.pubkey}:${t.talkD}"
        }.onFailure { error = msg(it) }
    }

    fun enrollSelf() = scope.launch {
        enrolling = true; enrollError = null
        try {
            org.enrollSelf(ctx)
            c.session.account.value?.let { runCatching { c.grants.receive(it.signer, maxUnwraps = 10) } }
            refresh()
            enrollSent = true
        } catch (e: Exception) { enrollError = msg(e) } finally { enrolling = false }
    }

    fun makeInvites(count: Int) = scope.launch {
        generating = true; error = null
        runCatching { invites = org.generateInvites(ctx, count.coerceIn(1, 100)); refreshInviteReport() }.onFailure { error = msg(it) }
        generating = false
    }

    fun makeShared(uses: Int?, hours: Double?) = scope.launch {
        generatingShared = true; error = null
        runCatching {
            sharedInvite = org.generateInvites(ctx, 1, "door", uses = if (uses != null && uses > 0) uses else 0, exp = Invites.sharedInviteExp(hours, System.currentTimeMillis())).firstOrNull()
            refreshInviteReport()
        }.onFailure { error = msg(it) }
        generatingShared = false
    }

    fun nameFor(pk: String): String? =
        directory?.firstOrNull { it.pubkey == pk }?.name ?: pending.firstOrNull { it.attendeePubkey == pk }?.name?.ifBlank { null }
}
