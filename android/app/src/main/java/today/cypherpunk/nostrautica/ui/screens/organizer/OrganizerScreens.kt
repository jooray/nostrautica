package today.cypherpunk.nostrautica.ui.screens.organizer

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.StubScreen

@Composable
fun CreateScreen() = StubScreen("title.create")

@Composable
fun AdminScreen(naddr: String) = StubScreen("title.admin", naddr)

@Composable
fun EventSettingsScreen(naddr: String) = StubScreen("title.eventSettings", naddr)
