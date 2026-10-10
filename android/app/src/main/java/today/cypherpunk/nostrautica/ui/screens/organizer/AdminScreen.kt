package today.cypherpunk.nostrautica.ui.screens.organizer

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.organizer.AdminModel
import today.cypherpunk.nostrautica.domain.organizer.CoordinatorHelpers
import today.cypherpunk.nostrautica.domain.organizer.Invites
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.QrCode
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** AdminTabs.svelte: Administration · Settings. */
@Composable
fun AdminTabs(naddr: String, settings: Boolean) {
    val s = LocalStrings.current
    val router = LocalRouter.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SmallButton(s.t("admin.tab.manage"), { if (settings) router.replace(Route.Admin(naddr)) }, selected = !settings)
        SmallButton(s.t("admin.tab.settings"), { if (!settings) router.replace(Route.EventSettings(naddr)) }, selected = settings)
    }
}

@Composable
fun AdminHeader(titleKey: String, naddr: String, settings: Boolean) {
    val s = LocalStrings.current
    val router = LocalRouter.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { ScreenTitle(s.t(titleKey)) }
            SmallButton(s.t("admin.done"), { router.switchTo(Route.Event(naddr)) })
        }
        AdminTabs(naddr, settings)
    }
}

fun shortPk(pk: String) = pk.take(8) + "…" + pk.takeLast(4)

/** PersonId.svelte: a name (or short key), long-press copies the nprofile. */
@Composable
fun PersonLine(pubkey: String, name: String?, relays: List<String>) {
    val ctx = LocalContext.current
    val s = LocalStrings.current
    Column(Modifier.clickable {
        copyText(ctx, Nip19.nprofile(Nip19.Profile(pubkey, relays.take(2))))
        Toasts.show(s.t("admin.copied"))
    }) {
        Text(name?.ifBlank { null } ?: shortPk(pubkey), fontWeight = FontWeight.SemiBold)
        Text(Nip19.npub(pubkey).take(18) + "…", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = LocalTokens.current.textDim)
    }
}

/** pages/Admin.svelte — the Manage tab. */
@Composable
fun AdminScreen(naddr: String) {
    EventScaffold(naddr) { p -> AdminBody(p, naddr) }
}

@OptIn(FlowPreview::class, ExperimentalLayoutApi::class)
@Composable
private fun AdminBody(p: androidx.compose.foundation.layout.PaddingValues, naddr: String) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ev = LocalEvent.current
    val router = LocalRouter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    val keysVersion by c.eventKeys.changes.collectAsState()
    val account by c.session.account.collectAsState()
    val st = remember(ev.ctx.coordinate, ev.ctx.configAt) { AdminState(c, ev.ctx, scope) { s }.also { it.keys = org.keysFor(ev.ctx.coordinate) } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(st, keysVersion, account) { st.keys = org.keysFor(st.coordinate) }
    // Organizer role without E_id here: try the relay backup before giving up.
    LaunchedEffect(account) {
        val k = org.keysFor(st.coordinate)
        if (account != null && k?.role == "organizer" && k.eidNsecHex == null) runCatching { org.recoverEventKeys(force = true) }
    }
    val isOrg = st.keys?.role == "organizer"
    LaunchedEffect(st, isOrg) {
        if (!isOrg) return@LaunchedEffect
        st.paintFromCache()
        st.loading = false
        launch { st.refreshLiveness() }
        launch { st.refreshPosts() }
        st.refresh()
    }
    // A live 1059 subscription to the inboxes while this screen is visible,
    // instead of the PWA's 30 s poll: a new request refreshes the queue at once.
    LaunchedEffect(st, isOrg, st.keys?.einboxNsecHex) {
        val k = st.keys ?: return@LaunchedEffect
        if (!isOrg || k.einboxNsecHex == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            org.liveInbox(st.ctx, k).debounce(1_500).collect { st.refresh() }
        }
    }

    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf(AdminModel.Filter.ALL) }
    var detail by remember { mutableStateOf<String?>(null) }

    Page(p) {
        item { AdminHeader("admin.title", naddr, settings = false) }
        st.error?.let { e -> item { ErrorCard(e, { st.error = null }, s.t("common.close")) } }
        if (!isOrg) {
            item { GrantWaitCard(st.coordinate) { st.keys = org.keysFor(st.coordinate) } }
            return@Page
        }
        if (st.loading) { item { Loading(s.t("admin.loading")) }; return@Page }
        val pendingList = st.visiblePending
        val people = st.approvedPeople
        val talkPks = st.talks.map { it.pubkey }.toSet()
        val filterable = pendingList.map { AdminModel.Filterable(it.attendeePubkey, it.name, false, !it.media.isNullOrEmpty() || !it.introText.isNullOrBlank(), AdminModel.Op.OK, it.attendeePubkey in talkPks) } +
            people.map { AdminModel.Filterable(it.pubkey, it.name, true, it.hasIntro, it.op, it.pubkey in talkPks) }
        val filtered = AdminModel.filterPeople(filterable, filter, query)
        val filterActive = filter != AdminModel.Filter.ALL || query.isNotBlank()
        val matched = filtered.map { it.pubkey }.toSet()

        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (st.refreshing) Dim(s.t("admin.refreshing"), size = 12)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SmallButton(s.tp("admin.pending", pendingList.size), {}, enabled = pendingList.isNotEmpty())
                    SmallButton(s.t("admin.refresh"), { scope.launch { st.refresh() } })
                }
                st.lastRefreshed?.let { at ->
                    val (k, n) = AdminModel.sinceLabel(at)
                    Dim(s.t("admin.freshness", "ago" to s.t(k, "n" to n)), size = 12)
                }
            }
        }
        item { OverviewCard(st) }
        item { SectionHead(s.t("admin.section.operations")) }
        if (st.missingEid) item { SoftCard(color = t.warnSoft) { Text(s.t("admin.noEidKey.title"), fontWeight = FontWeight.SemiBold); Dim(s.t("admin.noEidKey.body")) } }
        if (!st.selfEnrolled && !st.missingEid) item {
            Card {
                Text(s.t("admin.enrollSelf.title"), fontWeight = FontWeight.SemiBold)
                Dim(s.t("admin.enrollSelf.body"))
                if (st.enrollSent) Dim(s.t("admin.enrollSelf.sent"))
                else SmallButton(if (st.enrolling) s.t("admin.enrollSelf.busy") else s.t("admin.enrollSelf.action"), { st.enrollSelf() }, enabled = !st.enrolling, selected = true)
                st.enrollError?.let { Text(it, color = t.danger, fontSize = 13.sp) }
            }
        }
        item { CoordinatorOpsCard(st, naddr) }
        st.poison.forEach { ps -> item(key = "poison" + AdminModel.statusId(ps)) { PoisonCard(st, ps) } }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Field(query, { query = it }, s.t("admin.people.search"))
                ChoiceField(s.t("admin.people.filter"), AdminModel.Filter.entries.map { it to s.t(it.key) }, filter, { filter = it })
                if (filterActive) Dim(s.tp("admin.people.matchCount", filtered.size), size = 12)
            }
        }
        // ── Join requests (AdminQueue.svelte) ──
        item { SectionTitle(s.t("admin.requests.title")) }
        if (pendingList.isEmpty()) item { Dim(s.t("admin.requests.none")) }
        else if (pendingList.size > 1) item {
            SmallButton(if (st.approvingAll) s.t("admin.requests.approving") else s.t("admin.requests.approveAll", "n" to pendingList.size), { st.approveAll() }, enabled = !st.approvingAll)
        }
        val summary = AdminModel.summarizeBulk(st.bulk)
        if (st.bulkRan && summary.done && (summary.approved > 0 || summary.needRetry > 0)) item {
            Dim(s.t("admin.requests.bulkSummary", "approved" to summary.approved, "retry" to summary.needRetry))
        }
        pendingList.filter { !filterActive || it.attendeePubkey in matched }.forEach { req ->
            item(key = "req" + req.attendeePubkey) { RequestCard(st, req) { detail = it } }
        }
        if (st.rejected.isNotEmpty()) item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dim(s.tp("admin.requests.rejectedCount", st.rejected.size), size = 13)
                SmallButton(s.t("admin.requests.undoRejects"), { st.rejected.forEach { pk -> st.setReview(pk, null) } })
            }
        }
        // ── Approved people (AdminPeople.svelte) ──
        if (people.isNotEmpty()) {
            item { SectionHead(s.t("admin.section.people")) }
            item { SectionTitle(s.t("admin.approved.title", "n" to people.size)) }
            people.filter { !filterActive || it.pubkey in matched }.forEach { person ->
                item(key = "p" + person.pubkey) { PersonCard(st, person) { detail = it } }
            }
        }
        if (st.cfg.talks != "off") {
            item { SectionHead(s.t("admin.talks.mod.section")) }
            item { TalksCard(st) }
        }
        item { SectionHead(s.t("admin.section.communicate")) }
        item { CommunicateCard(st) }
        item { InvitesCard(st) }
        item {
            val link = Route.webUrl(Route.Join(naddr))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(link, Modifier.weight(1f), fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 1)
                SmallButton(s.t("admin.inviteLink.copy"), { copyText(ctx, link); Toasts.show(s.t("admin.inviteLink.copied")) })
                SmallButton(s.t("admin.share"), { shareText(ctx, link, st.ctx.title) })
            }
        }
    }
    detail?.let { pk -> PersonDrawer(st, pk) { detail = null } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OverviewCard(st: AdminState) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val (exceptions, metrics) = st.overview()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (exceptions.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            exceptions.forEach { m -> MetricTile(m.labelKey, if (m.valueIsKey) s.t(m.value) else m.value, m.tone, highlight = true) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            metrics.forEach { m -> MetricTile(m.labelKey, if (m.valueIsKey) s.t(m.value) else m.value, m.tone) }
        }
    }
}

@Composable
private fun MetricTile(labelKey: String, value: String, tone: AdminModel.Tone, highlight: Boolean = false) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val bg = when { highlight -> t.dangerSoft; tone == AdminModel.Tone.WARN -> t.warnSoft; tone == AdminModel.Tone.OK -> t.okSoft; else -> t.bgElev }
    val fg = when (tone) { AdminModel.Tone.WARN -> t.warn; AdminModel.Tone.OK -> t.ok; else -> t.text }
    Column(Modifier.clip(RoundedCornerShape(12.dp)).background(bg).padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text(value, fontWeight = FontWeight.Bold, fontSize = 18.sp, color = fg)
        Text(s.t(labelKey), fontSize = 12.sp, color = t.textDim)
    }
}

@Composable
private fun CoordinatorOpsCard(st: AdminState, naddr: String) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val ctx = LocalContext.current
    val co = st.cfg.coordinator
    Card {
        if (co == null) {
            Dim(s.t("admin.coordinator.attachHint"))
            SmallButton(s.t("admin.tab.settings"), { router.replace(Route.EventSettings(naddr)) })
            return@Card
        }
        Text(s.t("admin.coordinator.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.coordinator.attached") + " " + co.take(16) + "…")
        Row(verticalAlignment = Alignment.CenterVertically) {
            val seen = st.lastSeen
            when {
                !st.livenessChecked && seen == null -> Pill(s.t("admin.checkingStatus"), t.warnSoft, t.warn)
                seen == null -> Pill(s.t("admin.coordinator.notSeen"), t.warnSoft, t.warn)
                else -> { val (k, n) = AdminModel.sinceLabel(seen); Pill(s.t(k, "n" to n), t.okSoft, t.ok) }
            }
            if (seen != null && System.currentTimeMillis() / 1000 - seen > AdminModel.COORD_QUIET_AFTER_SEC) Dim(s.t("admin.coordinator.idle"), size = 12)
        }
        st.billing?.let { b ->
            SoftCard(color = t.warnSoft) {
                Text(if (b.state == "payment_required") s.t("admin.billing.required") else s.t("admin.billing.grace"), fontWeight = FontWeight.SemiBold)
                b.reason?.let { Dim(it) }
                b.checkoutUrl?.let { CoordinatorHelpers.checkoutUrlForEvent(it, naddr) }?.let { url ->
                    SmallButton(s.t("admin.billing.checkout"), { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }, selected = true)
                }
            }
        }
        SmallButton(if (st.recomputing) s.t("admin.coordinator.recomputing") else s.t("admin.coordinator.recompute"), { st.recompute() }, enabled = !st.recomputing)
    }
}

@Composable
private fun PoisonCard(st: AdminState, ps: today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    SoftCard(color = t.dangerSoft) {
        Row { Text(s.t("admin.poison.title"), Modifier.weight(1f), fontWeight = FontWeight.SemiBold); ps.stage?.let { Pill(it, t.bgElev, t.textDim) } }
        Dim(s.t("admin.poison.body", "stage" to (ps.stage ?: ""), "attempts" to (ps.attempts ?: 0)))
        ps.pubkey?.let { Dim(s.t("admin.poison.attendee") + " " + shortPk(it)) }
        Dim(s.t("admin.poison.reason") + " " + (ps.errorCategory ?: "") + if (ps.retryable != true) " · " + s.t("admin.poison.notRetryable") else "")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val id = AdminModel.statusId(ps)
            if (ps.retryable == true) SmallButton(if (st.retryingStatus == id) s.t("admin.poison.retrying") else s.t("admin.poison.retry"), { st.retryStatus(ps) }, enabled = st.retryingStatus != id, selected = true)
            SmallButton(s.t("admin.poison.dismiss"), { st.dismissStatus(ps) })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RequestCard(st: AdminState, req: today.cypherpunk.nostrautica.domain.organizer.PendingRequest, onDetails: (String) -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    var confirmReject by remember { mutableStateOf(false) }
    val bulk = st.bulk.firstOrNull { it.pubkey == req.attendeePubkey }?.state
    val deferred = req.attendeePubkey in st.deferred
    Card {
        PersonLine(req.attendeePubkey, req.name, st.ctx.relays)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (req.invite != null) Pill(s.t("admin.requests.invite"), t.accentSoft, t.accent)
            if (deferred) Pill(s.t("admin.requests.reviewed"), t.bgElev2, t.textDim)
            req.media?.takeIf { it.isNotEmpty() }?.let { Pill(s.tp("admin.requests.video", it.size), t.bgElev2, t.textDim) }
        }
        if (req.withdrawn) Text(if (req.withdrawalRequestedPurge) s.t("admin.requests.withdrew.purge") else s.t("admin.requests.withdrew"), color = t.danger, fontSize = 13.sp)
        if (req.message.isNotBlank()) Dim(req.message)
        req.profile?.skills?.distinct()?.takeIf { it.isNotEmpty() }?.let { skills ->
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { skills.forEach { Pill(it, t.bgElev2, t.textDim) } }
        }
        when {
            bulk == AdminModel.BulkState.QUEUED || bulk == AdminModel.BulkState.PUBLISHING ->
                Dim(if (bulk == AdminModel.BulkState.PUBLISHING) s.t("admin.requests.bulk.publishing") else s.t("admin.requests.bulk.queued"))
            bulk == AdminModel.BulkState.FAILED -> {
                Text(s.t("admin.requests.bulk.failed"), color = t.danger, fontSize = 13.sp)
                SmallButton(s.t("admin.requests.bulk.retry"), { st.retryBulk(req.attendeePubkey) })
            }
            confirmReject -> {
                Dim(s.t("admin.requests.reject.confirm"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SmallButton(s.t("admin.requests.reject"), { st.setReview(req.attendeePubkey, "rejected"); confirmReject = false })
                    SmallButton(s.t("admin.revoke.keep"), { confirmReject = false })
                }
            }
            else -> FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SmallButton(s.t("admin.requests.approve"), { st.approve(req.attendeePubkey) }, enabled = req.attendeePubkey !in st.approving, selected = true)
                if (!deferred) SmallButton(s.t("admin.requests.leavePending"), { st.setReview(req.attendeePubkey, "deferred") })
                SmallButton(s.t("admin.requests.reject"), { confirmReject = true })
                SmallButton(s.t("admin.person.details"), { onDetails(req.attendeePubkey) })
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PersonCard(st: AdminState, person: AdminModel.Person, onDetails: (String) -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    var confirm by remember { mutableStateOf(false) }
    Card {
        PersonLine(person.pubkey, person.name, st.ctx.relays)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (person.role == "organizer") Pill(s.t("admin.people.organizer"), t.accentSoft, t.accent)
            person.media?.takeIf { it.isNotEmpty() }?.let { Pill(s.tp("admin.requests.video", it.size), t.bgElev2, t.textDim) }
            if (person.op == AdminModel.Op.FAILED) Pill(s.t("admin.people.failed"), t.warnSoft, t.warn)
        }
        if (!person.intakeAvailable && !person.revoked) Dim(s.t("admin.people.intakeUnavailable"), size = 13)
        if (person.withdrawn && !person.revoked) Text(if (person.withdrawalRequestedPurge) s.t("admin.people.withdrew.purge") else s.t("admin.people.withdrew"), color = t.danger, fontSize = 13.sp)
        when {
            person.revoked -> Dim(s.t("admin.revoked"))
            confirm -> {
                Dim(s.t("admin.revoke.confirm"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SmallButton(s.t("admin.revoke.revoke"), { st.revoke(person.pubkey); confirm = false })
                    SmallButton(s.t("admin.revoke.keep"), { confirm = false })
                }
            }
            else -> {
                Dim(s.t("admin.approvedTag"))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    SmallButton(s.t("admin.reprocess"), { st.reprocess(person.pubkey) })
                    SmallButton(s.t("admin.revoke.revoke"), { confirm = true })
                    SmallButton(s.t("admin.person.details"), { onDetails(person.pubkey) })
                }
            }
        }
    }
}

@Composable
private fun TalksCard(st: AdminState) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    Card {
        Text(s.t("admin.talks.mod.title"), fontWeight = FontWeight.SemiBold)
        when {
            st.cfg.coordinator == null -> Dim(s.t("admin.talks.mod.needsCoordinator"))
            st.visibleTalks.isEmpty() -> Dim(s.t("admin.talks.mod.none"))
            else -> {
                Dim(s.t("admin.talks.mod.body"))
                st.visibleTalks.forEach { tk ->
                    SoftCard(color = t.bgElev2) {
                        Text(tk.title, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Pill(tk.pubkey.take(8) + "…", t.bgElev, t.textDim)
                            if (tk.revision > 0) Pill(s.t("admin.talks.mod.revision", "n" to tk.revision), t.bgElev, t.textDim)
                        }
                        if (tk.description.isNotBlank()) Dim(tk.description)
                        if (tk.externalUrl != null) {
                            Pill(s.t("talks.mod.externalLabel"), t.bgElev, t.textDim)
                            CoordinatorHelpers.httpsUrl(tk.externalUrl)?.let { url ->
                                SmallButton(s.t("admin.talks.mod.preview"), { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } })
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SmallButton(s.t("admin.talks.mod.publish"), { st.moderate(tk, "talk_publish") }, selected = true)
                            SmallButton(s.t("admin.talks.mod.reject"), { st.moderate(tk, "talk_reject") })
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InvitesCard(st: AdminState) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    var count by remember { mutableStateOf("5") }
    var sharedOpen by remember { mutableStateOf(false) }
    var sharedUses by remember { mutableStateOf("100") }
    var sharedHours by remember { mutableStateOf("4") }
    var exportsOpen by remember { mutableStateOf(false) }
    var csv by remember { mutableStateOf(true) }
    var unusedOnly by remember { mutableStateOf(false) }
    val rows = Invites.buildUsageRows(st.report.issued, st.report.used) { st.nameFor(it) }
    val fmt = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, Locale.forLanguageTag(s.locale))
    fun expiry(exp: Long?) = if (exp == null) s.t("admin.invites.shared.noExpiry") else s.t("admin.invites.shared.expiresAt", "date" to fmt.format(Date(exp * 1000)))
    val naddr = st.ctx.naddr
    Card {
        Text(s.t("admin.invites.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.invites.body"))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NumberField(count, { count = it }, s.t("organizer.invites.count"), modifier = Modifier.weight(1f))
            SmallButton(if (st.generating) s.t("admin.invites.generating") else s.t("admin.invites.generate"), { st.makeInvites(count.toIntOrNull() ?: 1) }, enabled = !st.generating)
        }
        Text(s.t("admin.invites.shared.title"), Modifier.clickable { sharedOpen = !sharedOpen }, fontWeight = FontWeight.SemiBold, color = t.accent)
        if (sharedOpen) {
            Dim(s.t("admin.invites.shared.body"), size = 13)
            NumberField(sharedUses, { sharedUses = it }, s.t("admin.invites.shared.uses"))
            Dim(s.t("admin.invites.shared.usesHint"), size = 12)
            NumberField(sharedHours, { sharedHours = it }, s.t("admin.invites.shared.hours"), decimal = true)
            // Say what THIS form will mint before it does (0 = never expires).
            Text(expiry(Invites.sharedInviteExp(sharedHours.toDoubleOrNull(), System.currentTimeMillis())), fontSize = 13.sp)
            SmallButton(if (st.generatingShared) s.t("admin.invites.generating") else s.t("admin.invites.shared.generate"), {
                st.makeShared(sharedUses.toIntOrNull(), sharedHours.toDoubleOrNull())
            }, enabled = !st.generatingShared)
            Dim(s.t("admin.invites.shared.forwardHint"), size = 12)
            st.sharedInvite?.let { inv ->
                SoftCard(color = t.bgElev2) {
                    QrCode(inv.link, 260.dp, Modifier.align(Alignment.CenterHorizontally))
                    Text(inv.link, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    Text(expiry(inv.exp), fontSize = 13.sp)
                    SmallButton(s.t("admin.invites.copyLink"), { copyText(ctx, inv.link); Toasts.show(s.t("admin.copied")) })
                    Dim(s.t("admin.invites.shared.ephemeral"), size = 12)
                }
            }
        }
        if (st.report.issued.isNotEmpty()) Dim(s.t("admin.invites.usedCount", "used" to Invites.usedCount(rows), "total" to st.report.issued.size), size = 13)
        SmallButton(s.t("admin.invites.exports"), { exportsOpen = !exportsOpen }, selected = exportsOpen)
        if (exportsOpen) SoftCard(color = t.bgElev2) {
            Dim(s.t("admin.invites.exports.intro"), size = 13)
            Text(s.t("admin.invites.exportCodes.title"), fontWeight = FontWeight.SemiBold)
            Dim(s.t("admin.invites.exportCodes.body"), size = 13)
            if (st.invites.isEmpty()) Dim(s.t("admin.invites.exportCodes.unavailable"), size = 13)
            else Text(s.t("admin.invites.exportCodes.warning"), color = t.danger, fontSize = 13.sp)
            Text(s.t("admin.invites.format"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            RadioLine(s.t("admin.invites.format.csv"), csv, enabled = st.invites.isNotEmpty()) { csv = true }
            RadioLine(s.t("admin.invites.format.txt"), !csv, enabled = st.invites.isNotEmpty()) { csv = false }
            SmallButton(if (csv) s.t("admin.invites.downloadCsv") else s.t("admin.invites.download"), {
                if (csv) shareFile(ctx, Invites.exportFilename("codes", naddr, "csv"), "text/csv") { it.writeText(Invites.CSV_BOM + Invites.codesCsv(st.invites)) }
                else shareFile(ctx, Invites.exportFilename("codes", naddr, "txt"), "text/plain") { it.writeText(Invites.codesTxt(st.invites)) }
            }, enabled = st.invites.isNotEmpty())
            Text(s.t("admin.invites.exportUsed.title"), fontWeight = FontWeight.SemiBold)
            Dim(s.t("admin.invites.exportUsed.body"), size = 13)
            if (st.report.issued.isEmpty()) Dim(s.t("admin.invites.exportUsed.empty"), size = 13)
            else {
                Text(s.t("admin.invites.scope"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                RadioLine(s.t("admin.invites.scope.all"), !unusedOnly) { unusedOnly = false }
                RadioLine(s.t("admin.invites.scope.unused"), unusedOnly) { unusedOnly = true }
                SmallButton(s.t("admin.invites.exportUsed.download"), {
                    shareFile(ctx, Invites.exportFilename("used", naddr, "csv"), "text/csv") { it.writeText(Invites.CSV_BOM + Invites.usageCsv(Invites.filterUsageRows(rows, unusedOnly))) }
                })
                Dim(if (st.reportBusy) s.t("admin.invites.exportBusy") else s.t("admin.invites.usedNote"), size = 12)
            }
        }
        if (st.invites.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (st.invites.size > 1) SmallButton(s.t("admin.invites.copyAll"), { copyText(ctx, Invites.codesTxt(st.invites)); Toasts.show(s.t("admin.invites.copiedAll")) })
                SmallButton(s.t("admin.invites.printSheet"), {
                    val sheet = Invites.forSheet(st.invites, st.report.used)
                    shareFile(ctx, Invites.exportFilename("codes", naddr, "pdf"), "application/pdf") { f ->
                        writeInviteSheetPdf(f, sheet, st.ctx.title, s.t("admin.inviteSheet.scanHint"))
                    }
                })
            }
            st.invites.forEach { inv ->
                SoftCard(color = t.bgElev2) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Pill(inv.label, t.bgElev, t.textDim)
                        Text("", Modifier.weight(1f))
                        SmallButton(s.t("admin.invites.copyLink"), { copyText(ctx, inv.link); Toasts.show(s.t("admin.copied")) })
                    }
                    QrCode(inv.link, 150.dp)
                    Text(inv.link, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                }
            }
        }
    }
}

@Composable
fun RadioLine(label: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, onClick, enabled = enabled)
        Text(label, fontSize = 14.sp)
    }
}

/** AdminPersonDrawer.svelte: submitted profile, provenance and operational history. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun PersonDrawer(st: AdminState, pk: String, onClose: () -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val approved = st.approvedPeople.firstOrNull { it.pubkey == pk }
    val req = st.visiblePending.firstOrNull { it.attendeePubkey == pk }
    if (approved == null && req == null) { onClose(); return }
    val name = approved?.name ?: req?.name?.ifBlank { null } ?: shortPk(pk)
    val profile = approved?.profile ?: req?.profile
    val media = approved?.media ?: req?.media
    val introText = approved?.introText ?: req?.message
    val membership = AdminModel.membership(approved?.revoked == true, st.review[pk], approved?.inRoster == true, req != null)
    val timeline = AdminModel.timeline(st.statuses.filter { it.pubkey == pk }, st.talks.filter { it.pubkey == pk }.map { it.title to "pending" })
    ModalBottomSheet(onDismissRequest = onClose, containerColor = t.bgElev) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(s.t("admin.person.title", "name" to name), fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Pill(membershipLabel(s, membership), when (membership) { "approved" -> t.okSoft; "pending" -> t.warnSoft; "revoked", "rejected" -> t.dangerSoft; else -> t.bgElev2 }, t.text)
                if ((approved?.role ?: "attendee") == "organizer") Pill(s.t("admin.person.role.organizer"), t.accentSoft, t.accent)
            }
            Text(s.t("admin.person.profile"), fontWeight = FontWeight.SemiBold)
            if (approved?.intakeAvailable == false && req == null) Dim(s.t("admin.person.noIntake"))
            else {
                Dim(s.t("admin.person.intro") + ": " + introLabel(s, AdminModel.introKind(media, introText)))
                profile?.about?.takeIf { it.isNotBlank() }?.let { Text(s.t("admin.person.about"), fontWeight = FontWeight.Medium); Dim(it) }
                profile?.skills?.takeIf { it.isNotEmpty() }?.let { Text(s.t("admin.person.skills"), fontWeight = FontWeight.Medium); Dim(it.joinToString(", ")) }
                profile?.lookingFor?.takeIf { it.isNotBlank() }?.let { Text(s.t("admin.person.lookingFor"), fontWeight = FontWeight.Medium); Dim(it) }
                introText?.takeIf { it.isNotBlank() }?.let { Text(s.t("admin.person.introText"), fontWeight = FontWeight.Medium); Dim(it) }
            }
            Text(s.t("admin.person.history"), fontWeight = FontWeight.SemiBold)
            if (timeline.isEmpty()) Dim(s.t("admin.person.noHistory"))
            timeline.forEach { e ->
                Row {
                    Text(s.t(e.labelKey), Modifier.weight(1f), color = if (e.tone == AdminModel.Tone.WARN) t.warn else t.text)
                    e.detail?.let { Dim(it, size = 12) }
                }
            }
            PrimaryButton(s.t("common.close"), onClose)
        }
    }
}

private fun membershipLabel(s: today.cypherpunk.nostrautica.i18n.I18n.Strings, m: String) = when (m) {
    "revoked" -> s.t("admin.person.membership.revoked")
    "rejected" -> s.t("admin.person.membership.rejected")
    "deferred" -> s.t("admin.person.membership.deferred")
    "pending" -> s.t("admin.person.membership.pending")
    else -> s.t("admin.person.membership.approved")
}

private fun introLabel(s: today.cypherpunk.nostrautica.i18n.I18n.Strings, k: String) = when (k) {
    "video" -> s.t("admin.person.intro.video")
    "audio" -> s.t("admin.person.intro.audio")
    "text" -> s.t("admin.person.intro.text")
    else -> s.t("admin.person.intro.none")
}
