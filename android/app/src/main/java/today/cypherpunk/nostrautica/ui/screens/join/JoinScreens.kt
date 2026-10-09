package today.cypherpunk.nostrautica.ui.screens.join

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.StubScreen

@Composable
fun JoinScreen(r: Route.Join) = StubScreen("title.join", r.naddr)

@Composable
fun RecordScreen(r: Route.Record) = StubScreen("title.record", r.naddr)

@Composable
fun MyProfileScreen(naddr: String) = StubScreen("title.myProfile", naddr)
