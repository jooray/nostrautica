package today.cypherpunk.nostrautica.ui.screens

import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Body
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.EventWash
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.event.EventPageSections
import today.cypherpunk.nostrautica.ui.screens.event.MemberActions
import today.cypherpunk.nostrautica.ui.screens.event.OrganizerCard
import today.cypherpunk.nostrautica.ui.screens.event.ReadinessCard
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.EventState
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.theme.DisplayFont
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** The event header card (EventHeader.svelte): banner wash, serif title, date, place, role. */
@Composable
fun EventHeader(ev: EventState, compact: Boolean = false) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val allow by LocalContainer.current.prefs.externalImages.collectAsState()
    EventWash(ev.coordinate) {
        if (!compact && ev.ctx.banner != null && allow) {
            AsyncImage(ev.ctx.banner, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(120.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (compact) { EventIcon(ev.coordinate, ev.ctx.icon, ev.ctx.title, 28); Spacer(Modifier.width(10.dp)) }
            Text(ev.ctx.title, Modifier.weight(1f), fontFamily = DisplayFont, fontWeight = FontWeight.SemiBold, fontSize = if (compact) 18.sp else 26.sp)
            if (compact) RolePill(ev)
        }
        if (!compact) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ev.ctx.start?.let { Dim(shortDate(it, s.locale), size = 13) }
            ev.ctx.location?.let { Dim("· $it", size = 13, maxLines = 1) }
            Spacer(Modifier.weight(1f))
            RolePill(ev)
        }
    }
}

@Composable
fun RolePill(ev: EventState) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    when (ev.role) {
        Role.ORGANIZER, Role.ATTENDEE -> Pill(s.t("event.status.approved"), t.okSoft, t.ok)
        Role.PENDING -> Pill(s.t("event.status.pending"), t.warnSoft, t.warn)
        Role.VISITOR -> Pill(s.t("event.status.visitor"), t.bgElev2, t.textDim)
    }
}

fun shortDate(sec: Long, locale: String): String =
    DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(locale)).format(Date(sec * 1000))

fun dateTimeRange(start: Long, end: Long?, locale: String): String {
    val f = DateFormat.getDateTimeInstance(DateFormat.FULL, DateFormat.SHORT, Locale.forLanguageTag(locale))
    val tf = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.forLanguageTag(locale))
    val a = f.format(Date(start * 1000))
    if (end == null || end <= start) return a
    val sameDay = (start / 86400) == (end / 86400)
    return a + " – " + (if (sameDay) tf.format(Date(end * 1000)) else f.format(Date(end * 1000)))
}

/** LogisticsBlock.svelte: when, where, directions, add to calendar. */
@Composable
fun LogisticsBlock(ev: EventState) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    val start = ev.ctx.start ?: return
    val now = System.currentTimeMillis() / 1000
    Card {
        val end = ev.ctx.end
        val status = when {
            end != null && now > end -> s.t("logistics.ended")
            now >= start && (end == null || now <= end) -> s.t("logistics.happeningNow")
            (start - now) / 86400 == 0L -> s.t("logistics.today")
            else -> s.tp("logistics.inDays", ((start - now) / 86400).toInt())
        }
        Pill(status, t.bgElev2, t.textDim)
        Text(dateTimeRange(start, end, s.locale), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ev.ctx.location?.let { loc ->
                Dim(loc, Modifier.weight(1f, fill = false), maxLines = 2, size = 15)
                SmallButton(s.t("logistics.directions"), {
                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(loc)))) }
                })
            }
        }
        SmallButton(s.t("logistics.addToCalendar"), {
            val i = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start * 1000)
                .putExtra(CalendarContract.Events.TITLE, ev.ctx.title)
                .putExtra(CalendarContract.Events.DESCRIPTION, ev.ctx.summary + "\n\n" + Route.webUrl(Route.Event(ev.naddr)))
            end?.let { i.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, it * 1000) }
            ev.ctx.location?.let { i.putExtra(CalendarContract.Events.EVENT_LOCATION, it) }
            runCatching { ctx.startActivity(i) }
        })
    }
}

/** pages/EventHome.svelte — the Overview tab. */
@Composable
fun EventHomeScreen(naddr: String) {
    EventScaffold(naddr) { p ->
        val ev = LocalEvent.current
        val c = LocalContainer.current
        val router = LocalRouter.current
        val s = LocalStrings.current
        val t = LocalTokens.current
        val scope = rememberCoroutineScope()
        val account by c.session.account.collectAsState()
        var checking by remember { mutableStateOf(false) }

        // Waiting for approval: re-check grants on a slow, bounded cadence while
        // this screen is open (join.ts's adaptive poll), never in the background.
        val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(ev.role, account) {
            val a = account ?: return@LaunchedEffect
            if (ev.role != Role.PENDING) return@LaunchedEffect
            var gap = 5_000L
            val started = System.currentTimeMillis()
            // Only while the screen is actually visible: paused in the background.
            lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) { while (true) {
                delay(gap)
                c.cache.forget("homescan:${a.pubkey}")
                runCatching { c.grants.receive(a.signer, maxUnwraps = 10, interactive = false) }
                if (c.membership.role(a.pubkey, ev.coordinate) != Role.PENDING) {
                    c.membership.clearJoinSent(a.pubkey, ev.coordinate)
                    return@repeatOnLifecycle
                }
                gap = if (System.currentTimeMillis() - started > 180_000) 60_000 else 15_000
            } }
        }
        // Members: keep the roster/directory/matches warm (cache-first, TTL-bounded).
        LaunchedEffect(ev.role, account) {
            val a = account ?: return@LaunchedEffect
            if (ev.isMember) runCatching { c.members.refresh(ev.ctx, a.signer) }
        }

        Page(p) {
            item { EventHeader(ev) }
            if (ev.ctx.summary.isNotBlank()) item { Body(ev.ctx.summary) }
            item { LogisticsBlock(ev) }
            when (ev.role) {
                Role.VISITOR -> item {
                    Card {
                        SectionTitle(s.tc("event.join", ev.isCommunity))
                        Dim(s.tc("event.join.body", ev.isCommunity))
                        PrimaryButton(s.tc("event.join", ev.isCommunity), { router.go(Route.Join(naddr)) })
                    }
                }
                Role.PENDING -> item {
                    SoftCard(color = t.warnSoft) {
                        Text(s.t("event.requestSent"), fontWeight = FontWeight.SemiBold)
                        Dim(s.tc("event.requestSent.body", ev.isCommunity))
                        SmallButton(if (checking) s.t("error.state.retrying") else s.t("event.checkStatus"), {
                            val a = account ?: return@SmallButton
                            checking = true
                            scope.launch { runCatching { c.grants.receive(a.signer, force = true) }; checking = false }
                        })
                    }
                }
                else -> {}
            }
            if (ev.isMember) item { ReadinessCard(ev) }
            if (ev.isMember) item { MemberActions(ev) }
            // Organizers get admin/duplicate; a signed-in non-member gets the
            // organizer-key recovery offer (a fresh device), so the slot decides.
            if (ev.isOrganizer || (account != null && !ev.isMember)) item { OrganizerCard(ev) }
            item { EventPageSections(ev) }
            ev.ctx.cfg.retentionDays?.let { days -> item { Dim(s.t("event.retention.line", "days" to days), size = 13) } }
        }
    }
}

