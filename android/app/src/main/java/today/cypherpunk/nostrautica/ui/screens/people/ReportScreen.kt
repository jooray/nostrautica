package today.cypherpunk.nostrautica.ui.screens.people

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.FollowListGuard
import today.cypherpunk.nostrautica.domain.Social
import today.cypherpunk.nostrautica.domain.people.EventReport
import today.cypherpunk.nostrautica.domain.people.PeopleNames
import today.cypherpunk.nostrautica.domain.people.Report
import today.cypherpunk.nostrautica.domain.content.content
import today.cypherpunk.nostrautica.domain.people.ReportPerson
import today.cypherpunk.nostrautica.domain.people.ReportTalk
import today.cypherpunk.nostrautica.domain.people.eventSettings
import today.cypherpunk.nostrautica.domain.people.observeMany
import today.cypherpunk.nostrautica.i18n.I18n
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Body
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.EventHeader
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** A friendly date (range) for the event: "1 August 2026", or a span. */
private fun dateLine(start: Long?, end: Long?, locale: String): String {
    if (start == null) return ""
    val l = Locale.forLanguageTag(locale)
    val full = DateFormat.getDateInstance(DateFormat.LONG, l)
    if (end == null) return full.format(Date(start * 1000))
    val sameDay = java.time.Instant.ofEpochSecond(start).atZone(java.time.ZoneId.systemDefault()).toLocalDate() ==
        java.time.Instant.ofEpochSecond(end).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
    if (sameDay) return full.format(Date(start * 1000))
    val dm = java.time.format.DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(l, "MMMMd"), l)
    return dm.format(java.time.Instant.ofEpochSecond(start).atZone(java.time.ZoneId.systemDefault())) + " – " + full.format(Date(end * 1000))
}

private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

/** The print view: plain, self-describing HTML (the PWA prints its page; Android prints this). */
private fun reportHtml(s: I18n.Strings, title: String, date: String, summary: String, r: EventReport, generated: String): String = buildString {
    fun people(h: String, list: List<ReportPerson>) {
        if (list.isEmpty()) return
        append("<h2>").append(esc(h)).append("</h2><ul>")
        list.forEach { p ->
            append("<li><strong>").append(esc(p.name)).append("</strong><br><code>").append(esc(p.npub)).append("</code>")
            p.note?.let { append("<p>").append(esc(it)).append("</p>") }
            append("</li>")
        }
        append("</ul>")
    }
    append("<!doctype html><html><head><meta charset='utf-8'><style>")
    append("body{font-family:Georgia,serif;margin:24px;color:#111}h1{margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px;border-bottom:1px solid #ccc}")
    append("ul{list-style:none;padding:0}li{margin:0 0 10px;break-inside:avoid}code{font-size:10px;color:#555}p{margin:4px 0}.k{color:#666;text-transform:uppercase;font-size:11px;letter-spacing:.08em}.g{color:#777;font-size:11px;margin-top:28px}")
    append("</style></head><body>")
    append("<p class='k'>").append(esc(s.t("report.kicker"))).append("</p><h1>").append(esc(title)).append("</h1>")
    if (date.isNotEmpty()) append("<p>").append(esc(date)).append("</p>")
    if (summary.isNotEmpty()) append("<p>").append(esc(summary)).append("</p>")
    people(s.t("report.met"), r.met)
    people(s.t("report.wantedNotMet"), r.wantedNotMet)
    if (r.favoriteTalks.isNotEmpty()) {
        append("<h2>").append(esc(s.t("report.favoriteTalks"))).append("</h2><ul>")
        r.favoriteTalks.forEach { append("<li>").append(esc(it.title)).append("</li>") }
        append("</ul>")
    }
    people(s.t("report.notes"), r.notes)
    append("<p class='g'>").append(esc(generated)).append("</p></body></html>")
}

/** Print through the system dialog (which also offers "Save as PDF"). */
private fun printHtml(ctx: Context, jobName: String, html: String, keep: (WebView?) -> Unit) {
    val wv = WebView(ctx)
    keep(wv)
    wv.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) {
            val pm = ctx.getSystemService(PrintManager::class.java)
            pm?.print(jobName, view.createPrintDocumentAdapter(jobName), PrintAttributes.Builder().build())
            keep(null)
        }
    }
    wv.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
}

/**
 * pages/Report.svelte — the post-event report: who you met, who you wanted to
 * meet but didn't, favourite talks and your private notes, assembled purely from
 * the private 30078 settings (and talks' local favourites). Print / save as PDF,
 * copy or save the npub list, and follow everyone with a per-person opt-out.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReportBody(padding: PaddingValues) {
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val me = account?.pubkey
    val owner = me ?: Cache.ANON
    val coord = ev.coordinate

    val observed by remember(owner, coord) { c.eventSettings.observe(owner, coord) }.collectAsState(null)
    var loaded by remember { mutableStateOf<PerEventSettings?>(null) }
    val settings = observed ?: loaded
    val entries by remember(owner, coord) { c.members.observeDirectory(owner, coord) }.collectAsState(emptyList())
    val pks = remember(entries, settings) { (entries.map { it.pubkey } + (settings?.met ?: emptyList()) + (settings?.wantToMeet ?: emptyList()) + (settings?.notes?.keys ?: emptySet())).distinct() }
    val profiles by remember(pks) { c.profiles.observeMany(pks) }.collectAsState(emptyMap())
    var favTalks by remember { mutableStateOf<List<ReportTalk>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(me, reload) {
        loading = true
        error = null
        val a = account
        if (a == null) { loading = false; return@LaunchedEffect }
        runCatching { c.content.favoriteTalkItems(a.pubkey, coord) }.onSuccess { l -> favTalks = l.map { (d, title) -> ReportTalk(d, title) } }
        runCatching { c.eventSettings.load(ev.ctx, force = reload > 0) }
            .onSuccess { loaded = it }
            .onFailure { e -> if (observed == null) error = e.message ?: e.toString() }
        loading = false
        // Names improve the report but aren't report data: enrich in the background.
        if (ev.isMember) runCatching { c.members.refresh(ev.ctx, a.signer) }
        runCatching { c.profiles.refresh(pks) }
    }

    val entryBy = remember(entries) { entries.associateBy { it.pubkey } }
    val report = remember(settings, favTalks, profiles, entryBy) {
        Report.assemble(settings ?: PerEventSettings(), favTalks) { pk -> PeopleNames.nameOf(pk, profiles[pk], entryBy[pk], entryBy[pk]?.profile?.about) }
    }
    val isLocalKey = account?.signer is LocalSigner
    val generated = s.t("report.generatedOn", "date" to DateFormat.getDateInstance(DateFormat.LONG, Locale.forLanguageTag(s.locale)).format(Date()))
    val dl = dateLine(ev.ctx.start, ev.ctx.end, s.locale)

    var copied by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var optOut by remember { mutableStateOf(emptySet<String>()) }
    var following by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<Social.FollowAllResult?>(null) }
    var followError by remember { mutableStateOf<String?>(null) }
    var printer by remember { mutableStateOf<WebView?>(null) }
    val saveTxt = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        if (uri != null) runCatching { ctx.contentResolver.openOutputStream(uri)?.use { it.write(Report.npubList(report.allPeople).toByteArray()) } }
    }

    Page(padding) {
        error?.let { msg -> item { ErrorCard(msg, { reload++ }, s.t("error.state.retry")) }; return@Page }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(s.t("report.kicker").uppercase(), Modifier.weight(1f), color = t.textDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
                SmallButton(s.t("report.print"), {
                    printHtml(ctx, s.t("report.title"), reportHtml(s, ev.ctx.title, dl, ev.ctx.summary, report, generated)) { printer = it }
                })
            }
        }
        item { EventHeader(ev) }
        if (dl.isNotEmpty() || ev.ctx.summary.isNotBlank()) item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (dl.isNotEmpty()) Text(dl, fontWeight = FontWeight.SemiBold)
                if (ev.ctx.summary.isNotBlank()) Body(ev.ctx.summary)
            }
        }
        when {
            loading && report.isEmpty -> item { Dim(s.t("report.loading")) }
            report.isEmpty -> item {
                Card {
                    Dim(s.t("report.empty"))
                    SmallButton(s.t("report.empty.people"), { router.switchTo(Route.Attendees(ev.naddr)) })
                }
            }
            else -> {
                item {
                    Card {
                        outcome?.let { o ->
                            val parts = buildList {
                                if (o.followed.isNotEmpty()) add(s.tp("report.followed", o.followed.size))
                                if (o.alreadyFollowing.isNotEmpty()) add(s.tp("report.alreadyFollowing", o.alreadyFollowing.size))
                                if (o.failed.isNotEmpty()) add(s.tp("report.followFailed", o.failed.size))
                            }
                            Text(parts.joinToString(" · "), color = if (o.failed.isNotEmpty()) t.danger else t.text)
                        }
                        val candidates = report.allPeople
                        if (!confirming) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (account != null && candidates.isNotEmpty()) SmallButton(s.t("report.followAll"), {
                                optOut = emptySet(); outcome = null; followError = null; confirming = true
                            }, selected = true)
                            SmallButton(if (copied) s.t("report.copied") else s.t("report.copyNpubs"), {
                                ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("npubs", Report.npubList(candidates)))
                                copied = true
                                scope.launch { delay(1_500); copied = false }
                            })
                            SmallButton(s.t("report.downloadNpubs"), { saveTxt.launch("nostrautica-people-${ev.naddr.take(12)}.txt") })
                        } else {
                            Text(s.t("report.followConfirm.title"), fontWeight = FontWeight.SemiBold)
                            Dim(s.t("report.followConfirm.body"), size = 13)
                            candidates.forEach { p ->
                                Row(
                                    Modifier.fillMaxWidth().clickable { optOut = if (p.pubkey in optOut) optOut - p.pubkey else optOut + p.pubkey },
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Checkbox(p.pubkey !in optOut, { optOut = if (p.pubkey in optOut) optOut - p.pubkey else optOut + p.pubkey })
                                    Text(p.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Spacer(Modifier.width(6.dp))
                                    Text(p.npub.take(14) + "…", color = t.textDim, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                                }
                            }
                            followError?.let { Text(it, color = t.danger, fontSize = 13.sp) }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                PrimaryButton(
                                    if (following) s.t("report.following") else s.t("report.followSelected", "n" to (candidates.size - optOut.count { o -> candidates.any { it.pubkey == o } })),
                                    {
                                        val st = settings ?: return@PrimaryButton
                                        val targets = Report.followTargets(st, optOut)
                                        if (targets.isEmpty()) { confirming = false; return@PrimaryButton }
                                        following = true
                                        followError = null
                                        PeopleWrites.launch {
                                            runCatching { c.social.followAll(targets) }
                                                .onSuccess { outcome = it; confirming = false }
                                                .onFailure { e -> followError = if (e is FollowListGuard) s.t("error.followListGuard") else e.message ?: e.toString() }
                                            following = false
                                        }
                                    },
                                    Modifier.weight(1f), busy = following,
                                )
                                SmallButton(s.t("report.cancel"), { confirming = false }, enabled = !following)
                            }
                        }
                    }
                }
                if (report.met.isNotEmpty()) section(s.t("report.met"), report.met, profiles.mapValues { it.value.picture })
                if (report.wantedNotMet.isNotEmpty()) section(s.t("report.wantedNotMet"), report.wantedNotMet, profiles.mapValues { it.value.picture })
                if (report.favoriteTalks.isNotEmpty()) {
                    item { SectionTitle(s.t("report.favoriteTalks")) }
                    report.favoriteTalks.forEach { talk -> item { Body("• " + talk.title) } }
                }
                if (report.notes.isNotEmpty()) section(s.t("report.notes"), report.notes, profiles.mapValues { it.value.picture })
                item { Dim(generated, size = 12) }
                if (isLocalKey) item {
                    Card {
                        SectionTitle(s.t("report.switch.title"))
                        Dim(s.t("report.switch.body"))
                        PrimaryButton(s.t("report.switch.action"), { router.go(Route.Me) })
                    }
                }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(title: String, people: List<ReportPerson>, pictures: Map<String, String?>) {
    item { SectionTitle(title) }
    people.forEach { p ->
        item(key = title + p.pubkey) {
            Row(verticalAlignment = Alignment.Top) {
                Avatar(p.pubkey, p.name, pictures[p.pubkey], 44.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(p.name, fontWeight = FontWeight.SemiBold)
                    Text(p.npub, color = LocalTokens.current.textDim, fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    p.note?.let { Body(it) }
                }
            }
        }
    }
}
