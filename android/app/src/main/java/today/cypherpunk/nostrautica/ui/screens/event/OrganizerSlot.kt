package today.cypherpunk.nostrautica.ui.screens.event

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.organizer.DuplicateDraft
import today.cypherpunk.nostrautica.domain.organizer.DuplicatePrefill
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.signer.silently
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventState

/**
 * The organizer's slot on the event Overview (EventHome.svelte): the admin entry
 * and "Duplicate event" for an organizer; for a signed-in non-member, the offer to
 * restore organizer keys from this account's relay backup (a fresh device).
 */
@Composable
fun OrganizerCard(ev: EventState) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val router = LocalRouter.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    var recovering by remember { mutableStateOf(false) }
    var result by remember(ev.coordinate) { mutableStateOf<String?>(null) }

    if (ev.isOrganizer) {
        Card {
            SecondaryButton(s.t("event.organizerAdmin"), { router.go(Route.Admin(ev.naddr)) }, icon = Icons.Outlined.Tune)
            SecondaryButton(s.t("event.duplicate"), {
                DuplicateDraft.set(DuplicatePrefill.from(ev.ctx.title, ev.ctx.summary, ev.ctx.icon, ev.ctx.banner, ev.ctx.cfg) { s.t("event.duplicate.copyOf", "title" to it) })
                router.go(Route.Create)
            }, icon = Icons.Outlined.ContentCopy)
            if (result == "restored") Dim(s.t("event.recoverKeys.restored"))
        }
        return
    }
    val a = account ?: return
    if (ev.role == Role.ATTENDEE) return

    // A key on this phone decrypts silently, so a returning organizer gets custody
    // back without asking (the PWA's prefetchOrganizerRecovery); a remote signer
    // only on the button below, never as an unprompted signer dialog.
    LaunchedEffect(a.pubkey, ev.coordinate) {
        if (a.signer.isLocal) runCatching { silently { c.organizer.recoverEventKeys() } }
    }
    Card {
        Text(s.t("event.recoverKeys.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("event.recoverKeys.body"))
        SmallButton(if (recovering) s.t("event.recoverKeys.working") else s.t("event.recoverKeys.action"), {
            recovering = true; result = null
            scope.launch {
                result = runCatching { c.organizer.recoverEventKeys(force = true) }.fold(
                    { restored -> if (ev.coordinate in restored && c.organizer.isOrganizer(ev.coordinate)) "restored" else "empty" },
                    { "failed" },
                )
                recovering = false
            }
        }, enabled = !recovering)
        when (result) {
            "empty" -> Dim(s.t("event.recoverKeys.empty"))
            "failed" -> Dim(s.t("event.recoverKeys.failed"))
        }
    }
}
