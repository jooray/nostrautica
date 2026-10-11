package today.cypherpunk.nostrautica.ui.screens.organizer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.LinkedParent
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.screens.shortDate
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * Organizer controls for the space hierarchy (§15), on the settings page (CommunitySettings.svelte):
 *
 *  - on a dated event: choose which of YOUR communities it belongs to. Choosing one publishes both
 *    halves of the link (the community lists the event, the event names the community) and, for an
 *    event with no coordinator, re-sends the key grant of everyone already approved so they can be
 *    offered the community too.
 *  - on a community: the events that belong to it, each removable.
 *
 * Removing a link never revokes memberships already granted.
 */
@Composable
fun CommunitySettingsCard(ctx: EventContext, onChanged: () -> Unit) {
    if (ctx.isCommunity) CommunityChildren(ctx, onChanged) else CommunityPicker(ctx, onChanged)
}

@Composable
private fun CommunityPicker(ctx: EventContext, onChanged: () -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val org = c.organizer
    val scope = rememberCoroutineScope()
    var communities by remember(ctx.coordinate) { mutableStateOf<List<EventContext>>(emptyList()) }
    var loaded by remember(ctx.coordinate) { mutableStateOf(false) }
    var current by remember(ctx.coordinate) { mutableStateOf<LinkedParent?>(null) }
    var selected by remember(ctx.coordinate, ctx.cfg.parent) { mutableStateOf(ctx.cfg.parent ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(ctx.coordinate, ctx.cfg.parent) {
        communities = runCatching { org.listOrganizedCommunities() }.getOrDefault(emptyList())
        current = c.communities.loadLinkedParent(ctx)
        selected = ctx.cfg.parent ?: ""
        loaded = true
    }

    val parent = ctx.cfg.parent
    val dirty = selected != (parent ?: "")
    val currentIsMine = parent != null && communities.any { it.coordinate == parent }

    fun save() {
        if (busy || !dirty) return
        busy = true; error = null; note = null
        scope.launch {
            try {
                if (parent != null && selected.isEmpty()) {
                    org.unlinkEventFromCommunity(ctx)
                    note = s.t("hierarchy.settings.unlinked")
                } else {
                    val community = communities.firstOrNull { it.coordinate == selected } ?: return@launch
                    // Moving between communities: drop this event from the old one first.
                    if (parent != null && parent != selected) org.unlinkEventFromCommunity(ctx)
                    val regranted = org.linkEventToCommunity(ctx, community)
                    note = if (regranted > 0) s.t("hierarchy.settings.linkedRegranted", "title" to community.title, "n" to regranted.toString())
                    else s.t("hierarchy.settings.linked", "title" to community.title)
                }
                onChanged()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = e.message ?: e.toString()
            } finally { busy = false }
        }
    }

    Card {
        Text(s.t("hierarchy.picker.label"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("hierarchy.picker.help"), size = 13)
        if (loaded && communities.isEmpty() && parent == null) {
            Dim(s.t("hierarchy.picker.empty"), size = 13)
        } else {
            val options = buildList {
                add("" to s.t("hierarchy.picker.none"))
                communities.forEach { add(it.coordinate to it.title) }
                if (parent != null && !currentIsMine) add(parent to (current?.title ?: s.t("hierarchy.picker.other")))
            }
            ChoiceField(s.t("hierarchy.picker.label"), options, selected, { selected = it }, enabled = !busy && loaded)
            if (parent != null && !currentIsMine && loaded) {
                Dim(s.t("hierarchy.settings.foreign", "title" to (current?.title ?: s.t("hierarchy.picker.other"))), size = 13)
            }
            SmallButton(if (busy) s.t("hierarchy.settings.saving") else s.t("hierarchy.settings.save"), { save() }, enabled = !busy && dirty && loaded)
        }
        error?.let { Text(it, color = LocalTokens.current.danger, fontSize = 14.sp) }
        note?.let { Dim(it) }
    }
}

@Composable
private fun CommunityChildren(ctx: EventContext, onChanged: () -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val org = c.organizer
    val scope = rememberCoroutineScope()
    var children by remember(ctx.coordinate) { mutableStateOf<List<ChildSummary>>(emptyList()) }
    var loaded by remember(ctx.coordinate) { mutableStateOf(false) }
    var removing by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(ctx.coordinate, ctx.cfg.children) {
        children = c.communities.cachedChildren(ctx)
        loaded = children.isNotEmpty()
        children = runCatching { c.communities.loadChildren(ctx) }.getOrDefault(children)
        loaded = true
    }

    Card {
        Text(s.t("hierarchy.children.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("hierarchy.children.body"), size = 13)
        if (!loaded) Dim(s.t("hierarchy.overview.loading"))
        else if (children.isEmpty()) Dim(s.t("hierarchy.children.empty"), size = 13)
        else children.forEach { child ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(child.title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    child.start?.let { Dim(shortDate(it, s.locale), size = 13) }
                }
                SmallButton(if (removing == child.coordinate) s.t("hierarchy.children.removing") else s.t("hierarchy.children.remove"), {
                    if (removing != null) return@SmallButton
                    removing = child.coordinate; error = null; note = null
                    scope.launch {
                        try {
                            org.setCommunityChild(ctx.coordinate, child.coordinate, false, ctx.cfg.relays)
                            children = children.filter { it.coordinate != child.coordinate }
                            note = s.t("hierarchy.children.removed", "title" to child.title)
                            onChanged()
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            error = e.message ?: e.toString()
                        } finally { removing = null }
                    }
                }, enabled = removing == null)
            }
        }
        error?.let { Text(it, color = LocalTokens.current.danger, fontSize = 14.sp) }
        note?.let { Dim(it) }
    }
}
