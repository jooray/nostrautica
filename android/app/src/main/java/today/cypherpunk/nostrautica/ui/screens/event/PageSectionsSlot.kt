package today.cypherpunk.nostrautica.ui.screens.event

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.flowOf
import today.cypherpunk.nostrautica.domain.content.Content
import today.cypherpunk.nostrautica.domain.content.EventPost
import today.cypherpunk.nostrautica.domain.content.PageLogic
import today.cypherpunk.nostrautica.domain.content.PostLogic
import today.cypherpunk.nostrautica.domain.content.ResolvedTarget
import today.cypherpunk.nostrautica.domain.content.content
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.PageSection
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.Notice
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.content.PostCard
import today.cypherpunk.nostrautica.ui.screens.content.openExternal
import today.cypherpunk.nostrautica.ui.shell.EventState
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/** The most a home feed renders inline; the rest is one tap away under "All posts". */
private const val HOME_FEED_MAX = 20

/**
 * The organizer-configured part of the Overview (EventHome.svelte below the
 * header): the 31608 menu with "All posts ›", the "Latest" highlight, then the
 * page's sections — posts by source × visibility, pinned articles, and (members
 * only) the attendees widget — or, with no sections published, the default
 * feed of the organizer's updates. Paints from the phone; refreshes when stale.
 */
@Composable
fun EventPageSections(ev: EventState) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val ctx = LocalContext.current
    val content = c.content
    val account by c.session.account.collectAsState()
    val owner = account?.pubkey
    val keysVersion by c.eventKeys.changes.collectAsState()
    val coord = ev.coordinate

    val page by remember(owner, coord) { content.observePage(owner, coord) }.collectAsState(null)
    val own by remember(owner, coord) { content.observePosts(owner, coord, Content.Slot.EVENT) }.collectAsState(null)
    val external by remember(owner, coord) { content.observePosts(owner, coord, Content.Slot.EXTERNAL) }.collectAsState(null)
    val attendees by remember(owner, coord) { content.observePosts(owner, coord, Content.Slot.ATTENDEES) }.collectAsState(null)
    val rosterCount by remember(owner, coord) { if (owner == null) flowOf(null) else content.observeRosterCount(owner, coord) }.collectAsState(null)
    var loading by remember(coord) { mutableStateOf(true) }
    var pinned by remember(coord, owner) { mutableStateOf<Map<String, EventPost>>(emptyMap()) }

    LaunchedEffect(coord, owner, keysVersion) {
        runCatching { content.refresh(ev.ctx, owner, attendees = false) }
        loading = false
    }
    val official = remember(own, external) { (own ?: emptyList()) + (external ?: emptyList()) }
    val sections = page?.sections ?: emptyList()
    val refs = remember(sections) { sections.flatMap { (it.section as? PageSection.Pinned)?.refs ?: emptyList() } }
    // Pinned refs: this event's posts by `d` (foreign refs are skipped), from the feeds or by a single read.
    LaunchedEffect(refs, official, keysVersion) {
        if (refs.isEmpty()) return@LaunchedEffect
        val eid = ev.ctx.coord.pubkey
        val out = LinkedHashMap<String, EventPost>()
        for (ref in refs) {
            val d = PageLogic.pinnedD(eid, ref) ?: continue
            val hit = official.firstOrNull { it.d == d && it.authorPubkey == eid }
                ?: runCatching { content.postByD(ev.ctx, owner, d) }.getOrNull()
            if (hit != null) out[ref] = hit
        }
        pinned = out
    }

    val latest = PageLogic.latest(official)
    val featured = buildSet { latest?.let { add(it.key) }; pinned.values.forEach { add(it.key) } }

    fun openTarget(target: String) {
        when (val r = PageLogic.resolveTarget(ev.ctx.coord.pubkey, target)) {
            is ResolvedTarget.Post -> router.go(Route.Post(ev.naddr, r.d))
            is ResolvedTarget.Url -> openExternal(ctx, r.href)
            is ResolvedTarget.Naddr -> openExternal(ctx, "nostr:" + r.naddr)
            null -> Unit
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        // The event menu: the organizer's links, then the posts archive.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            page?.menu?.forEach { item ->
                SmallButton(item.label, { openTarget(item.target) }, icon = if (item.membersOnly) Icons.Outlined.Lock else null)
            }
            SmallButton(s.t("event.allPosts"), { router.go(Route.Posts(ev.naddr)) }, icon = Icons.Outlined.Campaign)
        }
        if (page?.newer == true || official.any { it.newer }) Notice(s.t("content.updateNeeded"))

        if (latest != null) {
            Text(s.t("event.latest").uppercase(), color = t.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
            PostCard(latest, ev.naddr, full = PostLogic.expandsInFeed(latest))
        }
        if (loading && official.isEmpty() && page == null) Dim(s.t("event.loading"))

        if (sections.isNotEmpty()) {
            sections.forEach { item ->
                when (val sec = item.section) {
                    is PageSection.Posts -> {
                        val list = PageLogic.sectionPosts(sec, official, attendees ?: emptyList(), featured)
                        if (list.isNotEmpty()) {
                            SectionTitle(s.t("event.posts"))
                            list.take(HOME_FEED_MAX).forEach { PostCard(it, ev.naddr, full = PostLogic.expandsInFeed(it)) }
                        }
                    }
                    is PageSection.Pinned -> {
                        val pins = sec.refs.mapNotNull { pinned[it] }
                        if (pins.isNotEmpty()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.PushPin, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(6.dp))
                                SectionTitle(s.t("event.pinned"))
                            }
                            pins.forEach { PostCard(it, ev.naddr, full = true) }
                        }
                    }
                    is PageSection.Attendees -> if (ev.isMember) Card {
                        Text(s.t("event.attendeesSection"), fontWeight = FontWeight.SemiBold)
                        rosterCount?.let { Dim(s.tp("event.attendeesSection.count", it, "n" to it)) }
                        SmallButton(s.t("event.seeWhosHere"), { router.go(Route.Attendees(ev.naddr)) })
                    }
                }
            }
        } else {
            val rest = official.filter { it.key !in featured }.sortedByDescending { it.publishedAt }
            if (rest.isNotEmpty()) {
                SectionTitle(s.t("event.updates"))
                rest.take(HOME_FEED_MAX).forEach { PostCard(it, ev.naddr, full = PostLogic.expandsInFeed(it)) }
            }
        }
    }
}
