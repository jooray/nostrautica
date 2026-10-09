package today.cypherpunk.nostrautica.ui.screens.dm

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.StubScreen

@Composable
fun DmListScreen() = StubScreen("title.dm")

@Composable
fun DmThreadScreen(r: Route.DmPeer) = StubScreen("title.dmPeer")
