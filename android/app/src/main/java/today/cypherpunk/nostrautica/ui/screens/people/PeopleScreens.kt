package today.cypherpunk.nostrautica.ui.screens.people

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventScaffold

/** `#/e/<naddr>/attendees` — People (roster + matches). */
@Composable
fun AttendeesScreen(naddr: String) {
    EventScaffold(naddr) { p -> AttendeesBody(p) }
}

/** `#/e/<naddr>/attendees/<npub>` — one person. Back goes to People. */
@Composable
fun AttendeeScreen(r: Route.Attendee) {
    val s = LocalStrings.current
    val router = LocalRouter.current
    EventScaffold(r.naddr, back = s.t("attendees.title") to { if (!router.back()) router.switchTo(Route.Attendees(r.naddr)) }) { p ->
        AttendeeBody(p, r.npub)
    }
}

/** `#/e/<naddr>/report` — the post-event report. */
@Composable
fun ReportScreen(naddr: String) {
    EventScaffold(naddr) { p -> ReportBody(p) }
}
