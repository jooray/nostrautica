package today.cypherpunk.nostrautica.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Login
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.OndemandVideo
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.MutableSharedFlow
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.EventKeys
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.UpdateRequired
import today.cypherpunk.nostrautica.domain.people.whatsNew
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.domain.dm.dms
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.BackPill
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.IconSquare
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/** App-wide transient messages (the PWA's op-status toasts). */
object Toasts {
    val flow = MutableSharedFlow<String>(extraBufferCapacity = 8)
    fun show(text: String) { flow.tryEmit(text) }
}

/** The role-and-config gates of the event shell (stores/event-shell.svelte.ts). */
data class EventState(
    val ctx: EventContext,
    val role: Role,
    val keys: EventKeys?,
) {
    val isOrganizer get() = role == Role.ORGANIZER
    val isMember get() = role == Role.ATTENDEE || role == Role.ORGANIZER
    val isPending get() = role == Role.PENDING
    val showPeople get() = isMember
    val showMatches get() = isMember && ctx.cfg.coordinator != null && ctx.cfg.matching
    val showTalks get() = isMember && ctx.cfg.talks != "off"
    val talksFirst get() = ctx.cfg.talks == "prerecord-first"
    val showChat get() = isMember && ctx.cfg.isMarmotChatEnabled
    val isCommunity get() = ctx.isCommunity
    val naddr get() = ctx.naddr
    val coordinate get() = ctx.coordinate
}

val LocalEvent = staticCompositionLocalOf<EventState> { error("not inside an event") }

@Composable
private fun ThemeToggle() {
    val prefs = LocalContainer.current.prefs
    val dark = LocalTokens.current.dark
    val s = LocalStrings.current
    IconSquare(if (dark) Icons.Outlined.LightMode else Icons.Outlined.DarkMode, s.t("nav.toggleTheme"), { prefs.setTheme(if (dark) "light" else "dark") })
}

/** The strip above the content: a back pill (or the brand) and the theme toggle. */
@Composable
fun TopStrip(back: Pair<String, () -> Unit>?) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    // Opaque: page content scrolls under it.
    Column(Modifier.fillMaxWidth().background(t.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                if (back != null) BackPill(back.first, back.second)
                else Text(s.t("app.brand"), color = t.accent, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }
            ThemeToggle()
        }
        HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = t.border)
    }
}

data class NavItem(val icon: ImageVector, val label: String, val active: Boolean, val badge: Int = 0, val dot: Boolean = false, val avatar: (@Composable () -> Unit)? = null, val onClick: () -> Unit)

@Composable
fun BottomBar(items: List<NavItem>) {
    val t = LocalTokens.current
    Column(Modifier.fillMaxWidth().background(t.bgRaised)) {
        HorizontalDivider(color = t.border)
        Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).height(64.dp)) {
            for (item in items) {
                Column(
                    Modifier.weight(1f).fillMaxSize().clickable(onClick = item.onClick),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(Modifier.width(28.dp).height(2.dp).background(if (item.active) t.accent else Color.Transparent))
                    Spacer(Modifier.height(8.dp))
                    Box {
                        if (item.avatar != null) item.avatar.invoke()
                        else Icon(item.icon, null, Modifier.size(24.dp), tint = if (item.active) t.accent else t.textDim)
                        if (item.badge == 0 && item.dot) {
                            Box(Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-2).dp).size(8.dp).clip(CircleShape).background(t.accent))
                        }
                        if (item.badge > 0) {
                            Text(
                                if (item.badge > 99) "99+" else item.badge.toString(),
                                Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-4).dp).clip(CircleShape).background(t.danger).padding(horizontal = 5.dp),
                                color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(item.label, fontSize = 12.sp, color = if (item.active) t.accent else t.textDim, fontWeight = if (item.active) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun AppScaffold(top: @Composable () -> Unit, bottom: @Composable () -> Unit, content: @Composable (PaddingValues) -> Unit) {
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { Toasts.flow.collect { snack.showSnackbar(it) } }
    Scaffold(
        topBar = top,
        bottomBar = bottom,
        snackbarHost = { SnackbarHost(snack) },
        containerColor = LocalTokens.current.bg,
        contentWindowInsets = WindowInsets(0),
        content = content,
    )
}

/** A scrolling page body with the PWA's 16 px gutters. */
@Composable
fun Page(padding: PaddingValues, content: LazyListScope.() -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding() + 16.dp, bottom = padding.calculateBottomPadding() + 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        content = content,
    )
}

/** Global routes (BottomNav.svelte): Home · Chat · Me · Settings, or Home · Log in · Settings. */
@Composable
fun GlobalScaffold(back: Pair<String, () -> Unit>? = null, content: @Composable (PaddingValues) -> Unit) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val account by c.session.account.collectAsState()
    val r = router.current
    val items = buildList {
        add(NavItem(Icons.Outlined.Home, s.t("nav.events"), r is Route.Home) { router.resetTo(Route.Home) })
        if (account != null) {
            val unread by c.dms.unreadCount.collectAsState()
            val encrypted by c.dms.hasEncryptedActivity.collectAsState()
            add(NavItem(Icons.AutoMirrored.Outlined.Chat, s.t("nav.chat"), r is Route.Dm || r is Route.DmPeer, badge = unread, dot = encrypted) { router.switchTo(Route.Dm) })
            add(NavItem(Icons.Outlined.Person, s.t("nav.me"), r is Route.Me) { router.switchTo(Route.Me) })
        } else {
            add(NavItem(Icons.Outlined.Login, s.t("nav.login"), r is Route.Login) { router.switchTo(Route.Login()) })
        }
        add(NavItem(Icons.Outlined.Tune, s.t("nav.settings"), r is Route.Settings) { router.switchTo(Route.Settings) })
    }
    AppScaffold(top = { TopStrip(back) }, bottom = { BottomBar(items) }, content = content)
}

/**
 * Everything under `#/e/<naddr>/…`: loads the event (cache first), resolves the
 * role from local key custody, and renders the role-gated event bar.
 */
@Composable
fun EventScaffold(naddr: String, back: Pair<String, () -> Unit>? = null, content: @Composable (PaddingValues) -> Unit) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val account by c.session.account.collectAsState()
    val keysVersion by c.eventKeys.changes.collectAsState()
    val membershipVersion by c.membership.version.collectAsState()
    var error by remember(naddr) { mutableStateOf<String?>(null) }
    var reload by remember(naddr) { mutableStateOf(0) }
    val ctx by produceState<EventContext?>(null, naddr, reload) {
        value = c.contexts.cached(naddr)
        error = null
        runCatching { c.contexts.get(naddr, force = reload > 0) }
            .onSuccess { value = it; c.membership.noteOpened(account?.pubkey ?: "anon", it.coordinate, naddr) }
            .onFailure { e ->
                if (value == null) error = when {
                    e is UpdateRequired -> s.t("update.available")
                    e.message == "error.badEventLink" -> s.t("error.badEventLink")
                    else -> s.t("event.loadFailed") + "\n\n" + s.t("event.loadFailed.body")
                }
            }
    }
    val state = remember(ctx, account, keysVersion, membershipVersion) {
        ctx?.let { cx ->
            val owner = account?.pubkey
            EventState(cx, c.membership.role(owner, cx.coordinate), owner?.let { c.eventKeys.get(it, cx.coordinate) })
        }
    }
    LaunchedEffect(state?.ctx?.cfg?.lang, account) {
        if (account == null) state?.ctx?.cfg?.lang?.let { c.i18n.adoptEventLang(it) }
    }
    val r = router.current
    val unread by c.dms.unreadCount.collectAsState()
    val encrypted by c.dms.hasEncryptedActivity.collectAsState()
    // People tab badge: new arrivals + new matches since the list was last open (pure cache read).
    val peopleBadge by remember(account?.pubkey, state?.coordinate, state?.isMember) {
        val coord = state?.coordinate
        val owner = account?.pubkey
        if (coord != null && owner != null && state.isMember) c.whatsNew.peopleBadge(owner, coord) else kotlinx.coroutines.flow.flowOf(0)
    }.collectAsState(0)
    val backTo = back ?: (s.t("more.allEvents") to { if (!router.back()) router.resetTo(Route.Home) })
    val bottom: @Composable () -> Unit = {
        if (state != null) {
            val items = buildList {
                add(NavItem(Icons.Outlined.Explore, s.t("nav.overview"), r is Route.Event || r is Route.Join) { router.switchTo(Route.Event(naddr)) })
                val talks = NavItem(Icons.Outlined.OndemandVideo, s.t("nav.talks"), r is Route.Talks || r is Route.Talk) { router.switchTo(Route.Talks(naddr)) }
                if (state.showTalks && state.talksFirst) add(talks)
                if (state.showPeople) add(NavItem(Icons.Outlined.People, s.t("nav.people"), r is Route.Attendees || r is Route.Attendee, badge = peopleBadge) { router.switchTo(Route.Attendees(naddr)) })
                if (state.showTalks && !state.talksFirst) add(talks)
                if (state.showChat) add(NavItem(Icons.AutoMirrored.Outlined.Chat, s.t("nav.chat"), r is Route.Chat || r is Route.Dm || r is Route.DmPeer, badge = unread, dot = encrypted) { router.switchTo(Route.Chat(naddr)) })
                add(NavItem(Icons.Outlined.Campaign, s.t("nav.updates"), r is Route.Posts || r is Route.Post) { router.switchTo(Route.Posts(naddr)) })
                add(NavItem(Icons.Outlined.MoreHoriz, s.t("nav.more"), r is Route.EventMore || r is Route.MyProfile || r is Route.Admin || r is Route.EventSettings) { router.switchTo(Route.EventMore(naddr)) })
            }
            BottomBar(items)
        }
    }
    AppScaffold(top = { TopStrip(backTo) }, bottom = bottom) { padding ->
        when {
            state != null -> CompositionLocalProvider(LocalEvent provides state) { content(padding) }
            error != null -> Page(padding) { item { ErrorCard(error!!, { reload++ }, s.t("error.state.retry")) } }
            else -> Page(padding) { item { Loading(s.t("app.loading")) } }
        }
    }
}

/** A row in the More list. */
@Composable
fun MenuRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(t.bgElev).clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = t.textDim)
        Spacer(Modifier.width(14.dp))
        Text(label, Modifier.weight(1f), fontSize = 16.sp)
        Text("›", color = t.textDim, fontSize = 18.sp)
    }
}
