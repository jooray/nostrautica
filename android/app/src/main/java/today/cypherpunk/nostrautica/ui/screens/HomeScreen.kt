package today.cypherpunk.nostrautica.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import kotlinx.coroutines.async
import kotlinx.serialization.builtins.serializer
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.ScanOutcome
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.EventWash
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.GlobalScaffold
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

data class HomeEvent(val coordinate: String, val naddr: String, val ctx: EventContext?, val role: Role, val pendingKey: Boolean, val at: Long)

/** Which events to list: held keys, joins sent, self-copies found, and recently opened. */
suspend fun loadHomeEvents(c: AppContainer, account: Session.Account?): List<HomeEvent> = coroutineScope {
    val owner = account?.pubkey
    val scope = owner ?: "anon"
    val byCoord = LinkedHashMap<String, Long>()
    owner?.let { o -> c.eventKeys.list(o).forEach { byCoord[it.coordinate] = 0 } }
    owner?.let { o -> c.membership.joinsSent(o).forEach { (k, v) -> byCoord.merge(k, v, ::maxOf) } }
    owner?.let { o -> c.cache.prefix(o, "joined:", Long.serializer()).forEach { (k, v) -> byCoord.merge(k.removePrefix("joined:"), v, ::maxOf) } }
    val recent = c.membership.recent(scope).associateBy { it.coordinate }
    recent.values.forEach { byCoord.merge(it.coordinate, it.at, ::maxOf) }
    byCoord.keys.filter(Coordinate::isSpace).map { coord ->
        async {
            val naddr = recent[coord]?.naddr ?: Coordinate.parse(coord).toNaddr(c.contexts.relayHints(coord).take(2))
            val ctx = c.contexts.cached(naddr) ?: runCatching { c.contexts.get(naddr) }.getOrNull()
            val role = c.membership.role(owner, coord)
            val keys = owner?.let { c.eventKeys.get(it, coord) }
            val pending = role == Role.PENDING || (owner != null && keys?.current == null && c.cache.getRaw(owner, "joined:$coord") != null)
            HomeEvent(coord, naddr, ctx, role, pending, byCoord[coord] ?: 0)
        }
    }.awaitAll().sortedWith(compareByDescending<HomeEvent> { it.role == Role.ORGANIZER || it.role == Role.ATTENDEE }.thenByDescending { it.ctx?.start ?: it.at })
}

/** The grants + self-copy scan, at most every [SCAN_INTERVAL_MS] unless forced. */
suspend fun scanForEvents(c: AppContainer, account: Session.Account, force: Boolean): ScanOutcome {
    val outcome = ScanOutcome()
    val key = "homescan:${account.pubkey}"
    if (!force && c.cache.isFresh(key, SCAN_INTERVAL_MS)) return outcome
    runCatching { c.grants.receive(account.signer, force = force, outcome = outcome) }.onFailure { outcome.truncated = true }
    runCatching {
        c.membership.discoverJoined(account.signer).forEach { (coord, at) ->
            c.cache.put(account.pubkey, "joined:$coord", Long.serializer(), at, at)
        }
    }
    c.cache.markFetched(key)
    c.membership.bump()
    return outcome
}

const val SCAN_INTERVAL_MS = 3 * 60_000L

@Composable
fun HomeScreen() {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val needsBackup by c.session.needsBackup.collectAsState()
    val version by c.membership.version.collectAsState()
    val keysVersion by c.eventKeys.changes.collectAsState()
    var events by remember { mutableStateOf<List<HomeEvent>?>(null) }
    var scanning by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<ScanOutcome?>(null) }
    var deepDone by remember { mutableStateOf(false) }
    val online by c.nostr.network.collectAsState()

    LaunchedEffect(account, version, keysVersion) { events = loadHomeEvents(c, account) }
    LaunchedEffect(account) {
        val a = account ?: return@LaunchedEffect
        scanning = true
        outcome = scanForEvents(c, a, force = false)
        scanning = false
    }

    fun rescan(force: Boolean) {
        val a = account ?: return
        scope.launch { scanning = true; outcome = scanForEvents(c, a, force); scanning = false; deepDone = force }
    }

    GlobalScaffold { p ->
        Page(p) {
            item { ScreenTitle(s.t("home.title")) }
            item { Dim(s.t("home.intro"), size = 15) }
            if (!online) item { SoftCard(color = t.warnSoft) { Text(s.t("app.android.offlineCached")) } }
            if (account?.method == Session.Method.LOCAL && needsBackup) item {
                SoftCard(color = t.warnSoft) {
                    Text(s.t("home.backup.title"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("home.backup.body"))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(s.t("home.backup.now"), { router.go(Route.Me) }, Modifier.weight(1f))
                        SecondaryButton(s.t("home.backup.saved"), { c.session.markBackedUp() }, Modifier.weight(1f))
                    }
                }
            }
            val list = events.orEmpty()
            if (account == null) item {
                Card {
                    SectionTitle(if (list.isNotEmpty()) s.t("home.signedOut.title") else s.t("home.getStarted"))
                    Dim(if (list.isNotEmpty()) s.t("home.signedOut.stale") else s.t("home.getStarted.body"))
                    PrimaryButton(s.t("home.loginOrCreate"), { router.go(Route.Login()) })
                    SecondaryButton(s.t("home.createEvent"), { router.go(Route.Create) })
                }
            }
            if (list.isNotEmpty()) {
                item { SectionTitle(s.t("home.yourEvents")) }
                items(list.size, key = { list[it].coordinate }) { i -> EventRow(list[i]) { router.go(Route.Event(list[i].naddr)) } }
                if (list.any { it.pendingKey }) item { Dim(s.t("home.awaitingKey.note")) }
                if (outcome?.truncated == true) item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Dim(s.t("home.scanIncomplete"))
                        SecondaryButton(if (scanning) s.t("error.state.retrying") else s.t("error.state.retry"), { rescan(false) }, busy = scanning)
                    }
                }
                if (account != null) item { SecondaryButton(s.t("home.createAnother"), { router.go(Route.Create) }, icon = Icons.Outlined.Add) }
            } else if (account != null) {
                item {
                    when {
                        events == null || (scanning && list.isEmpty()) -> Card { Dim(s.t("home.loadingEvents")) }
                        !online -> Card { SectionTitle(s.t("home.cantCheck.title")); Dim(s.t("home.cantCheck.body")) }
                        else -> Card {
                            SectionTitle(s.t("home.noEvents"))
                            Dim(s.t("home.noEvents.body"))
                            PrimaryButton(s.t("home.createEvent"), { router.go(Route.Create) })
                        }
                    }
                }
            }
            if (account != null) item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if ((outcome?.unreachableEvents ?: 0) > 0) Dim(s.t("home.keysWaiting"))
                    Dim(s.t("home.deepScan.hint"), size = 13)
                    SecondaryButton(if (scanning) s.t("home.deepScan.busy") else s.t("home.deepScan.action"), { rescan(true) }, busy = scanning)
                    if (deepDone && !scanning) Dim(s.t("home.deepScan.done"), size = 13)
                }
            }
            item { AddEventByLink() }
            item {
                Card {
                    SectionTitle(s.t("home.how.title"))
                    for (k in listOf("home.how.record", "home.how.matched", "home.how.encrypted", "home.how.portable")) Dim("•  " + s.t(k))
                }
            }
        }
    }
}

@Composable
private fun EventRow(e: HomeEvent, onClick: () -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val title = e.ctx?.title ?: Coordinate.parseOrNull(e.coordinate)?.identifier?.replace('-', ' ') ?: "…"
    Card(onClick = onClick, padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            EventIcon(e.coordinate, e.ctx?.icon, title)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (e.pendingKey) Pill(s.t("home.role.awaitingKey"), t.warnSoft, t.warn)
                    else Pill(s.t(when (e.role) { Role.ORGANIZER -> "home.role.organizer"; Role.ATTENDEE -> "home.role.attendee"; else -> "home.role.visitor" }), t.bgElev2, t.textDim)
                }
            }
            Text("›", color = t.textDim, fontSize = 20.sp)
        }
    }
}

@Composable
fun EventIcon(coordinate: String, icon: String?, title: String, size: Int = 44) {
    val allow by LocalContainer.current.prefs.externalImages.collectAsState()
    if (icon != null && allow) {
        AsyncImage(icon, null, contentScale = ContentScale.Crop, modifier = Modifier.size(size.dp).clip(RoundedCornerShape(11.dp)))
    } else {
        EventWash(coordinate, Modifier.size(size.dp)) {}
    }
}

/** components/AddEventByLink.svelte: paste any link, naddr or coordinate. */
@Composable
fun AddEventByLink() {
    val s = LocalStrings.current
    val router = LocalRouter.current
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Card {
        SectionTitle(s.t("home.addByLink.title"))
        Dim(s.t("home.addByLink.body.native"))
        Field(text, { text = it; error = null }, s.t("home.addByLink.label"), placeholder = s.t("home.addByLink.placeholder"), isError = error != null, supporting = error)
        SecondaryButton(s.t("home.addByLink.action"), {
            val r = parseEventLink(text)
            if (r == null) error = s.t("error.badEventLink")
            else { router.go(r.first); text = "" }
        }, enabled = text.isNotBlank())
    }
}

private val NADDR = Regex("(naddr1[02-9ac-hj-np-z]+)", RegexOption.IGNORE_CASE)
private val COORD = Regex("(3192[3]|31612):([0-9a-f]{64}):([^\\s]+)")
private val CODE = Regex("[?&]code=(nsec1[02-9ac-hj-np-z]+)", RegexOption.IGNORE_CASE)

/** events/event-link.ts parseEventLink: a route for any shape of event link, or null. */
fun parseEventLink(raw: String): Pair<Route, String?>? {
    val input = raw.trim()
    if (input.isEmpty()) return null
    val decoded = runCatching { java.net.URLDecoder.decode(input, "UTF-8") }.getOrDefault(input)
    for (text in listOf(input, decoded)) {
        val at = text.indexOf('#')
        if (at >= 0) {
            val (route, lang) = Route.parseHash(text.substring(at))
            if (route is Route.InEvent && runCatching { Coordinate.fromNaddr(route.naddr).first.isSpace }.getOrDefault(false)) return route to lang
        }
    }
    val code = CODE.find(decoded)?.groupValues?.get(1)?.lowercase()
    NADDR.find(decoded)?.groupValues?.get(1)?.lowercase()?.let { n ->
        if (runCatching { Coordinate.fromNaddr(n).first.isSpace }.getOrDefault(false)) return (if (code != null) Route.Join(n, code) else Route.Event(n)) to null
    }
    COORD.find(decoded)?.value?.let { cs ->
        Coordinate.parseOrNull(cs)?.takeIf { it.isSpace }?.let { c -> val n = c.toNaddr(); return (if (code != null) Route.Join(n, code) else Route.Event(n)) to null }
    }
    return null
}
