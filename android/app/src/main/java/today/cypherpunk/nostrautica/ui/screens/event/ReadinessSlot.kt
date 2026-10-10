package today.cypherpunk.nostrautica.ui.screens.event

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.join.CtaTarget
import today.cypherpunk.nostrautica.domain.join.Readiness
import today.cypherpunk.nostrautica.domain.join.StepState
import today.cypherpunk.nostrautica.domain.join.joinFlow
import today.cypherpunk.nostrautica.domain.join.readiness
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.join.clockTime
import today.cypherpunk.nostrautica.ui.shell.EventState
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

// Overview slot owned by: join, record and my profile (ReadinessJourney.svelte).

private const val REFINE_EVERY_MS = 2 * 60_000L

/**
 * The readiness journey (ReadinessJourney.svelte): Joined → Backup → Intro →
 * Processing → Matches, with exactly one primary CTA. Paints from the phone at
 * once, then refines from relays at most every two minutes (or on "Check again").
 */
@Composable
fun ReadinessCard(ev: EventState) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val needsBackup by c.session.needsBackup.collectAsState()
    var readiness by remember(ev.coordinate) { mutableStateOf<Readiness?>(null) }
    var checkedAt by remember(ev.coordinate) { mutableStateOf<Long?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val a = account ?: return
    val holdsKey = a.method != Session.Method.LOCAL
    val localBackupOk = !(a.method == Session.Method.LOCAL && needsBackup)

    suspend fun refine() {
        if (refreshing) return
        refreshing = true
        try {
            runCatching { c.readiness.refine(a.signer, ev.ctx, ev.role, holdsKey, localBackupOk) { c.accounts.blindingKey() } }
                .onSuccess { (r, at) -> readiness = r; checkedAt = at }
        } finally { refreshing = false }
    }

    LaunchedEffect(ev.coordinate, a.pubkey, ev.role, needsBackup) {
        val cached = c.readiness.cached(a.pubkey, ev.coordinate)
        readiness = c.readiness.local(a.pubkey, ev.ctx, ev.role, holdsKey, localBackupOk).first
        checkedAt = cached?.checkedAt
        val stale = checkedAt?.let { System.currentTimeMillis() - it > REFINE_EVERY_MS } ?: true
        if (stale && c.nostr.network.value) refine()
    }

    val r = readiness ?: return
    // The primary CTA was derived for THIS event (no shared singleton to leak another's).
    fun go(target: CtaTarget) = when (target) {
        CtaTarget.JOIN -> router.go(Route.Join(ev.naddr))
        CtaTarget.BACKUP -> router.go(Route.Me)
        CtaTarget.RECORD -> router.go(Route.Record(ev.naddr))
        CtaTarget.MY_PROFILE -> router.go(Route.MyProfile(ev.naddr))
    }
    Card {
        if (r.allComplete) {
            Pill("✓ " + s.t("readiness.allSet"), t.okSoft, t.ok)
            if (r.matchesReady) PrimaryButton(s.t("readiness.cta.matches"), { router.switchTo(Route.Attendees(ev.naddr)) })
            else if (r.viewerIsMember) SecondaryButton(s.t("event.seeWhosHere"), { router.switchTo(Route.Attendees(ev.naddr)) })
            return@Card
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.t("readiness.title"), Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Pill(s.t("readiness.progress", "done" to r.doneCount, "total" to r.steps.size), t.accentSoft, t.accent)
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            r.steps.forEachIndexed { i, step ->
                val cls = when {
                    step.state == StepState.COMPLETE -> "done"
                    step.state == StepState.FAILED -> "fail"
                    i == r.currentIndex -> "cur"
                    else -> "todo"
                }
                val stateLabel = when (cls) {
                    "done" -> s.t("readiness.state.done")
                    "fail" -> s.t("readiness.state.failed")
                    "cur" -> s.t("readiness.state.current")
                    else -> s.t("readiness.state.upcoming")
                }
                Row(Modifier.semantics(mergeDescendants = true) { contentDescription = s.t(step.labelKey) + ", " + stateLabel }, verticalAlignment = Alignment.Top) {
                    val ring = when (cls) { "done" -> t.ok; "fail" -> t.danger; "cur" -> t.accent; else -> t.border }
                    Box(
                        Modifier.size(22.dp).clip(CircleShape).background(if (cls == "done") t.okSoft else t.bgElev).border(2.dp, ring, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        when (cls) {
                            "done" -> Icon(Icons.Outlined.Check, null, Modifier.size(13.dp), tint = t.ok)
                            "fail" -> Text("!", color = t.danger, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            "cur" -> Box(Modifier.size(8.dp).clip(CircleShape).background(t.accent))
                        }
                    }
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(s.t(step.labelKey), fontWeight = if (cls == "cur" || cls == "fail") FontWeight.SemiBold else FontWeight.Normal,
                            color = if (cls == "todo") t.textDim else t.text)
                        if ((cls == "cur" || cls == "fail") && step.hintKey != null) {
                            Text(s.t(step.hintKey), fontSize = 13.sp, color = if (cls == "fail") t.danger else t.textDim)
                        }
                    }
                }
            }
        }
        r.primary?.let { cta -> PrimaryButton(s.t(cta.labelKey), { go(cta.target) }) }
        if (r.matchesReady) SecondaryButton(s.t("readiness.cta.matches"), { router.switchTo(Route.Attendees(ev.naddr)) })
        else if (r.viewerIsMember) SecondaryButton(s.t("event.seeWhosHere"), { router.switchTo(Route.Attendees(ev.naddr)) })
        Row(verticalAlignment = Alignment.CenterVertically) {
            checkedAt?.let { Dim(s.t("readiness.lastChecked", "time" to clockTime(it, s.locale)), Modifier.weight(1f), size = 13) }
                ?: Spacer(Modifier.weight(1f))
            LinkButton(if (refreshing) s.t("readiness.checking") else s.t("readiness.checkAgain"), { scope.launch { refine() } })
        }
    }
}

/**
 * The rest of a member's Overview: own processing-failure notices (21606 sealed
 * to me), the offline note, and "Leave event" (21610) for attendees.
 */
@Composable
fun MemberActions(ev: EventState) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val a = account ?: return
    val poison by produceState(emptyList<today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent>(), ev.coordinate, a.pubkey) {
        value = c.grants.ownStatuses(a.pubkey, ev.coordinate).filter { it.state == "poison" && it.billing == null }
    }
    var confirming by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    var withdrawState by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        for (st in poison) {
            SoftCard(color = t.warnSoft) {
                Text(s.t("event.ownStatus.title"), fontWeight = FontWeight.SemiBold)
                Dim(when (st.stage) {
                    "process_talk" -> s.t("event.ownStatus.talk")
                    "chat_attestation" -> s.t("event.ownStatus.chat")
                    else -> s.t("event.ownStatus.submission")
                })
            }
        }
        Dim(s.t("event.android.offlineNote"), size = 13)
        if (ev.role == Role.ATTENDEE) {
            when {
                withdrawState != null -> Dim(if (withdrawState == "queued") s.t("event.leave.queued") else s.t("event.leave.requested"))
                failed -> Dim(s.t("event.leave.failed"))
                confirming -> {
                    Dim(s.t("event.leave.confirm"))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton(if (leaving) s.t("event.leave.leaving") else s.t("event.leave.confirmYes"), {
                            leaving = true
                            scope.launch {
                                runCatching { c.joinFlow.withdraw(a.signer, ev.ctx) }
                                    .onSuccess { withdrawState = if (it.sent) "sent" else "queued"; confirming = false }
                                    .onFailure { failed = true }
                                leaving = false
                            }
                        }, Modifier.weight(1f), busy = leaving, danger = true)
                        SecondaryButton(s.t("event.leave.cancel"), { confirming = false }, Modifier.weight(1f), enabled = !leaving)
                    }
                }
                else -> LinkButton(s.t("event.leave.action"), { confirming = true })
            }
        }
    }
}
