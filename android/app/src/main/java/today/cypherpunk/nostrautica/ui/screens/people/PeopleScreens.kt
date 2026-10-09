package today.cypherpunk.nostrautica.ui.screens.people

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.StubScreen

@Composable
fun AttendeesScreen(naddr: String) = StubScreen("title.attendees", naddr)

@Composable
fun AttendeeScreen(r: Route.Attendee) = StubScreen("title.attendee", r.naddr)

@Composable
fun ReportScreen(naddr: String) = StubScreen("title.report", naddr)
