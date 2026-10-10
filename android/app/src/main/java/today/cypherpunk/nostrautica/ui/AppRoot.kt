package today.cypherpunk.nostrautica.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.MutableStateFlow
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.i18n.rememberStrings
import today.cypherpunk.nostrautica.signer.SignerBridgeHost
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.nav.Router
import today.cypherpunk.nostrautica.ui.theme.NostrauticaTheme
import today.cypherpunk.nostrautica.ui.screens.EventHomeScreen
import today.cypherpunk.nostrautica.ui.screens.EventMoreScreen
import today.cypherpunk.nostrautica.ui.screens.HomeScreen
import today.cypherpunk.nostrautica.ui.screens.LoginScreen
import today.cypherpunk.nostrautica.ui.screens.MeScreen
import today.cypherpunk.nostrautica.ui.screens.SettingsScreen
import today.cypherpunk.nostrautica.ui.screens.StubScreen
import today.cypherpunk.nostrautica.ui.screens.chat.ChatScreen
import today.cypherpunk.nostrautica.ui.screens.content.PostScreen
import today.cypherpunk.nostrautica.ui.screens.content.PostsScreen
import today.cypherpunk.nostrautica.ui.screens.content.TalkScreen
import today.cypherpunk.nostrautica.ui.screens.content.TalksScreen
import today.cypherpunk.nostrautica.ui.screens.dm.DmListScreen
import today.cypherpunk.nostrautica.ui.screens.dm.DmThreadScreen
import today.cypherpunk.nostrautica.ui.screens.join.JoinScreen
import today.cypherpunk.nostrautica.ui.screens.join.MyProfileScreen
import today.cypherpunk.nostrautica.ui.screens.join.RecordScreen
import today.cypherpunk.nostrautica.ui.screens.organizer.AdminScreen
import today.cypherpunk.nostrautica.ui.screens.organizer.CreateScreen
import today.cypherpunk.nostrautica.ui.screens.organizer.EventSettingsScreen
import today.cypherpunk.nostrautica.ui.screens.people.AttendeeScreen
import today.cypherpunk.nostrautica.ui.screens.people.AttendeesScreen
import today.cypherpunk.nostrautica.ui.screens.people.ReportScreen

val LocalContainer = staticCompositionLocalOf<AppContainer> { error("no container") }
val LocalRouter = staticCompositionLocalOf<Router> { error("no router") }

@Composable
fun AppRoot(container: AppContainer, incoming: MutableStateFlow<Pair<Route, String?>?>) {
    val theme by container.prefs.theme.collectAsState()
    val strings = rememberStrings(container.i18n)
    val router = remember { Router() }
    val link by incoming.collectAsState()
    LaunchedEffect(link) {
        val (route, lang) = link ?: return@LaunchedEffect
        container.i18n.adoptInviteLang(lang)
        router.go(route)
        incoming.value = null
    }
    BackHandler(enabled = router.stack.size > 1) { router.back() }
    CompositionLocalProvider(LocalContainer provides container, LocalRouter provides router, LocalStrings provides strings) {
        NostrauticaTheme(theme) {
            SignerBridgeHost(container.bridge)
            Surface(Modifier.fillMaxSize()) {
                Screens(router.current)
            }
        }
    }
}

@Composable
fun Screens(route: Route) {
    // key() so per-screen state resets when the route changes to another event/person.
    androidx.compose.runtime.key(route) {
        when (route) {
            Route.Home -> HomeScreen()
            is Route.Login -> LoginScreen(route.nsec)
            Route.Me -> MeScreen()
            Route.Settings -> SettingsScreen()
            Route.Create -> CreateScreen()
            Route.Dm -> DmListScreen()
            is Route.DmPeer -> DmThreadScreen(route)
            is Route.NotFound -> StubScreen("title.notFound")
            is Route.Event -> EventHomeScreen(route.naddr)
            is Route.Join -> JoinScreen(route)
            is Route.Record -> RecordScreen(route)
            is Route.Attendees -> AttendeesScreen(route.naddr)
            is Route.Attendee -> AttendeeScreen(route)
            is Route.Report -> ReportScreen(route.naddr)
            is Route.Chat -> ChatScreen(route.naddr)
            is Route.Talks -> TalksScreen(route.naddr)
            is Route.Talk -> TalkScreen(route)
            is Route.MyProfile -> MyProfileScreen(route.naddr)
            is Route.Admin -> AdminScreen(route.naddr)
            is Route.EventSettings -> EventSettingsScreen(route.naddr)
            is Route.Posts -> PostsScreen(route.naddr)
            is Route.Post -> PostScreen(route)
            is Route.EventMore -> EventMoreScreen(route.naddr)
        }
    }
}
