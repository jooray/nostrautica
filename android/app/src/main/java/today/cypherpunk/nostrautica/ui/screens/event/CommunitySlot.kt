package today.cypherpunk.nostrautica.ui.screens.event

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.ChildSummary
import today.cypherpunk.nostrautica.domain.CommunityJoinDecision
import today.cypherpunk.nostrautica.domain.CommunityRules
import today.cypherpunk.nostrautica.domain.LinkedParent
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.EventIcon
import today.cypherpunk.nostrautica.ui.screens.shortDate
import today.cypherpunk.nostrautica.ui.shell.EventState
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * "Part of <community>" on a dated event's Overview, and for a member who holds a proof but
 * never agreed to join (they joined before this existed, or the grant was re-issued) a one-tap
 * offer (components/CommunityLinks.svelte, mode "header"). Nothing here ever joins anyone on its
 * own: the automatic path lives in Communities.autoJoin and only fires on consent given at the
 * join form.
 */
@Composable
fun CommunityHeader(ev: EventState) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val router = LocalRouter.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val membershipVersion by c.membership.version.collectAsState()
    var parent by remember(ev.coordinate) { mutableStateOf<LinkedParent?>(null) }
    var offer by remember(ev.coordinate) { mutableStateOf(false) }
    var state by remember(ev.coordinate) { mutableStateOf("idle") } // idle | sending | sent | failed

    if (ev.ctx.cfg.parent == null) return

    LaunchedEffect(ev.coordinate, ev.ctx.configAt) {
        parent = c.communities.cachedLinkedParent(ev.ctx)
        parent = c.communities.loadLinkedParent(ev.ctx)
    }
    LaunchedEffect(ev.isMember, account?.pubkey, ev.coordinate, membershipVersion) {
        offer = ev.isMember && account != null && c.communities.evaluateOffer(ev.coordinate).decision == CommunityJoinDecision.OFFER
    }

    val p = parent ?: return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        androidx.compose.material3.TextButton(onClick = { router.go(Route.Event(p.naddr)) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
            Text(s.t("hierarchy.overview.partOf", "title" to p.title) + " ›", fontWeight = FontWeight.SemiBold, color = LocalTokens.current.accent)
        }
        if (offer) {
            Card {
                Text(s.t("hierarchy.offer.title", "title" to p.title), fontWeight = FontWeight.SemiBold)
                Dim(s.t("hierarchy.offer.body", "event" to ev.ctx.title, "title" to p.title))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(
                        if (state == "sending") s.t("hierarchy.offer.joining") else s.t("hierarchy.offer.join"),
                        {
                            val a = account ?: return@PrimaryButton
                            if (state == "sending") return@PrimaryButton
                            state = "sending"
                            scope.launch {
                                state = if (runCatching { c.communities.joinViaChild(a.signer, ev.coordinate) }.getOrDefault(false)) "sent" else "failed"
                                if (state == "sent") offer = false
                            }
                        },
                        Modifier.weight(1f), enabled = state != "sending",
                    )
                    SecondaryButton(s.t("hierarchy.offer.later"), {
                        scope.launch { c.communities.dismissOffer(ev.coordinate); offer = false }
                    }, Modifier.weight(1f), enabled = state != "sending")
                }
                if (state == "failed") Text(s.t("hierarchy.offer.failed"), color = LocalTokens.current.danger, fontSize = 14.sp)
            }
        } else if (state == "sent") {
            Dim(s.t("hierarchy.offer.sent", "title" to p.title))
        }
    }
}

/** A community's own events, upcoming first and then past (CommunityLinks.svelte, mode "events"). */
@Composable
fun CommunityEvents(ev: EventState) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    if (ev.ctx.cfg.children.isEmpty()) return
    var children by remember(ev.coordinate) { mutableStateOf<List<ChildSummary>>(emptyList()) }
    var loaded by remember(ev.coordinate) { mutableStateOf(false) }
    LaunchedEffect(ev.coordinate, ev.ctx.configAt) {
        children = c.communities.cachedChildren(ev.ctx)
        loaded = children.isNotEmpty()
        children = c.communities.loadChildren(ev.ctx)
        loaded = true
    }
    val (upcoming, past) = CommunityRules.splitChildren(children, nowSec())
    Card {
        SectionTitle(s.t("hierarchy.overview.events"))
        if (!loaded) Dim(s.t("hierarchy.overview.loading"))
        else if (children.isEmpty()) Dim(s.t("hierarchy.overview.noEvents"))
        if (upcoming.isNotEmpty()) {
            Dim(s.t("hierarchy.overview.upcoming"), size = 13)
            upcoming.forEach { ChildRow(it) }
        }
        if (past.isNotEmpty()) {
            Dim(s.t("hierarchy.overview.past"), size = 13)
            past.forEach { ChildRow(it) }
        }
    }
}

@Composable
private fun ChildRow(child: ChildSummary) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    Row(
        Modifier.fillMaxWidth().clickable { router.go(Route.Event(child.naddr)) }.padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        EventIcon(child.coordinate, child.icon, child.title, 36)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(child.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            child.start?.let { Dim(shortDate(it, s.locale), size = 13) }
        }
        Text("›", color = t.textDim, fontSize = 20.sp)
    }
}
