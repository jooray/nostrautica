package today.cypherpunk.nostrautica.ui.screens.organizer

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.organizer.AdminModel
import today.cypherpunk.nostrautica.domain.organizer.CoordinatorHelpers
import today.cypherpunk.nostrautica.domain.organizer.DiscoveredCoordinator
import today.cypherpunk.nostrautica.domain.organizer.Organizer
import today.cypherpunk.nostrautica.domain.organizer.OrganizerEvents
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.EventPage
import today.cypherpunk.nostrautica.protocol.ExternalFeed
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MenuItem
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.PageSection
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale

/** pages/EventSettings.svelte — the Settings tab of the organizer area. */
@Composable
fun EventSettingsScreen(naddr: String) {
    EventScaffold(naddr) { p -> SettingsBody(p, naddr) }
}

private typealias Merged<T> = EventPage.Merged<T>

@Composable
private fun SettingsBody(p: PaddingValues, naddr: String) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ev = LocalEvent.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    val keysVersion by c.eventKeys.changes.collectAsState()
    val account by c.session.account.collectAsState()
    var ctx by remember(ev.ctx.coordinate) { mutableStateOf(ev.ctx) }
    val keys = remember(keysVersion, account, ctx.coordinate) { org.keysFor(ctx.coordinate) }
    var error by remember { mutableStateOf<String?>(null) }
    val isOrg = keys?.role == "organizer"

    LaunchedEffect(account) {
        if (account != null && keys?.role == "organizer" && keys.eidNsecHex == null) runCatching { org.recoverEventKeys(force = true) }
    }
    suspend fun reload() { ctx = runCatching { org.reload(naddr) }.getOrDefault(ctx) }
    /** Run a save: report the error, Toast on success, then re-read the context. */
    fun save(busy: (Boolean) -> Unit, done: () -> Unit = {}, block: suspend () -> Unit) {
        busy(true); error = null
        scope.launch {
            try { block(); reload(); done() } catch (e: Exception) { error = e.message ?: e.toString() } finally { busy(false) }
        }
    }

    Page(p) {
        item { AdminHeader("admin.settings.title", naddr, settings = true) }
        error?.let { e -> item { ErrorCard(e, { error = null }, s.t("common.close")) } }
        if (!isOrg) { item { GrantWaitCard(ctx.coordinate) {} }; return@Page }
        if (keys?.eidNsecHex == null) item { SoftCard(color = t.warnSoft) { Text(s.t("admin.noEidKey.title"), fontWeight = FontWeight.SemiBold); Dim(s.t("admin.noEidKey.body")) } }
        item { MetadataCard(ctx, { error = it }) { scope.launch { reload() } } }
        item { PageCard(ctx, { error = it }) }
        item { ThemeCard(ctx, { error = it }) }
        item { CoordinatorSettingsCard(ctx, { error = it }) { scope.launch { reload() } } }
        item {
            var mode by remember(ctx.cfg.talks) { mutableStateOf(ctx.cfg.talks) }
            var busy by remember { mutableStateOf(false) }
            var saved by remember { mutableStateOf(false) }
            Card {
                Text(s.t("admin.talks.title"), fontWeight = FontWeight.SemiBold)
                Dim(s.t("admin.talks.body"), size = 13)
                val opts = listOf("off" to s.t("create.talks.off"), "on" to s.t("create.talks.on")) +
                    (if (!ctx.isCommunity || mode == "prerecord-first") listOf("prerecord-first" to s.t("create.talks.prerecordFirst")) else emptyList())
                ChoiceField(s.t("admin.talks.title"), opts, mode, { mode = it })
                SmallButton(if (busy) s.t("admin.saving") else s.t("admin.talks.save"), {
                    save({ busy = it }, { saved = true }) { org.updateConfig(ctx, Organizer.ConfigChange(talks = mode)) }
                }, enabled = !busy && mode != ctx.cfg.talks)
                if (saved) { Dim(s.t("admin.saved")); LaunchedEffect(Unit) { delay(1500); saved = false } }
            }
        }
        item {
            var input by remember(ctx.cfg.retentionDays) { mutableStateOf(ctx.cfg.retentionDays?.toString() ?: "") }
            var busy by remember { mutableStateOf(false) }
            var saved by remember { mutableStateOf(false) }
            val parsed = input.trim().ifEmpty { null }?.toIntOrNull()
            Card {
                Text(s.t("admin.retention.title"), fontWeight = FontWeight.SemiBold)
                Dim(s.t("admin.retention.body"), size = 13)
                NumberField(input, { input = it }, s.t("admin.retention.unit"))
                Dim(if (input.isBlank()) s.t("admin.retention.consequenceOff") else s.t("admin.retention.consequence", "n" to input), size = 13)
                SmallButton(if (busy) s.t("admin.saving") else s.t("admin.retention.save"), {
                    if (input.isNotBlank() && (parsed == null || parsed < 1)) { error = s.t("admin.retention.invalid"); return@SmallButton }
                    save({ busy = it }, { saved = true }) { org.updateConfig(ctx, Organizer.ConfigChange(retention = parsed, setRetention = true)) }
                }, enabled = !busy && parsed != ctx.cfg.retentionDays)
                if (saved) { Dim(s.t("admin.saved")); LaunchedEffect(Unit) { delay(1500); saved = false } }
            }
        }
        item {
            var input by remember(ctx.cfg.relays) { mutableStateOf(ctx.cfg.relays.joinToString("\n")) }
            var busy by remember { mutableStateOf(false) }
            var saved by remember { mutableStateOf(false) }
            val parsed = OrganizerEvents.unionRelays(input.lines().map { it.trim() }.filter { it.isNotEmpty() })
            Card {
                Text(s.t("admin.relays.title"), fontWeight = FontWeight.SemiBold)
                Dim(s.t("admin.relays.body"), size = 13)
                Field(input, { input = it }, s.t("admin.relays.title"), placeholder = s.t("admin.relays.placeholder"), singleLine = false, minLines = 3)
                Dim(s.t("admin.relays.hint"), size = 12)
                if (chatRelaysOf(ctx.cfg).isNotEmpty()) Dim(s.t("admin.relays.chat", "relays" to chatRelaysOf(ctx.cfg).joinToString(", ")), size = 12)
                SmallButton(if (busy) s.t("admin.saving") else s.t("admin.relays.save"), {
                    if (parsed.isEmpty()) { error = s.t("admin.relays.empty"); return@SmallButton }
                    parsed.firstOrNull { !OrganizerEvents.isAcceptedRelayUrl(it) }?.let { error = s.t("admin.relays.invalid", "url" to it); return@SmallButton }
                    save({ busy = it }, { saved = true }) { org.updateConfig(ctx, Organizer.ConfigChange(relays = parsed)) }
                }, enabled = !busy && parsed != ctx.cfg.relays)
                if (saved) { Dim(s.t("admin.saved")); LaunchedEffect(Unit) { delay(1500); saved = false } }
            }
        }
        item {
            val current = "marmot" in ctx.cfg.chat
            var on by remember(current) { mutableStateOf(current) }
            var busy by remember { mutableStateOf(false) }
            var saved by remember { mutableStateOf(false) }
            Card {
                ToggleRow(s.t("chat.toggle.label"), on, { on = it }, enabled = ctx.cfg.coordinator != null, badge = s.t("chat.toggle.experimental"))
                Dim(s.t("chat.toggle.help"), size = 13)
                if (ctx.cfg.coordinator == null) Dim(s.t("chat.toggle.needsCoordinator"), size = 13)
                SmallButton(if (busy) s.t("admin.saving") else s.t("chat.toggle.save"), {
                    save({ busy = it }, { saved = true }) { org.updateConfig(ctx, Organizer.ConfigChange(chat = if (on) listOf("marmot") else emptyList())) }
                }, enabled = !busy && ctx.cfg.coordinator != null && on != current)
                if (saved) { Dim(s.t("admin.saved")); LaunchedEffect(Unit) { delay(1500); saved = false } }
            }
        }
        item {
            var input by remember { mutableStateOf("") }
            var busy by remember { mutableStateOf(false) }
            var sent by remember { mutableStateOf(false) }
            Card {
                Text(s.t("admin.coorg.title"), fontWeight = FontWeight.SemiBold)
                Dim(s.t("admin.coorg.body"), size = 13)
                Field(input, { input = it }, s.t("admin.coorg.placeholder"))
                SmallButton(if (busy) s.t("admin.coorg.adding") else s.t("admin.coorg.add"), {
                    val raw = input.trim()
                    val pk = if (raw.startsWith("npub1")) runCatching { Nip19.decodeNpub(raw) }.getOrNull() ?: run { error = s.t("admin.error.badNpub"); return@SmallButton } else raw
                    if (!Regex("^[0-9a-fA-F]{64}$").matches(pk)) { error = s.t("admin.error.enterNpub"); return@SmallButton }
                    busy = true; error = null
                    scope.launch {
                        try {
                            if (org.addCoOrganizer(ctx, pk.lowercase())) { Toasts.show(s.t("op.coOrgSent")); sent = true } else Toasts.show(s.t("op.coOrgQueued"))
                            input = ""
                        } catch (e: Exception) { error = e.message } finally { busy = false }
                    }
                }, enabled = !busy && input.isNotBlank())
                if (sent) Dim(s.t("admin.coorg.sent"))
            }
        }
    }
}

// ── Event details (event-metadata.ts) ───────────────────────────────────────

@Composable
private fun MetadataCard(ctx: EventContext, onError: (String) -> Unit, onSaved: () -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val actx = LocalContext.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    var title by remember(ctx.coordinate) { mutableStateOf(ctx.title) }
    var summary by remember(ctx.coordinate) { mutableStateOf(ctx.summary) }
    var start by remember(ctx.coordinate) { mutableStateOf(ctx.start) }
    var end by remember(ctx.coordinate) { mutableStateOf(ctx.end) }
    var location by remember(ctx.coordinate) { mutableStateOf(ctx.location ?: "") }
    var icon by remember(ctx.coordinate) { mutableStateOf(ctx.icon ?: "") }
    var banner by remember(ctx.coordinate) { mutableStateOf(ctx.banner ?: "") }
    var uploading by remember { mutableStateOf<String?>(null) }
    var pickWhich by remember { mutableStateOf("icon") }
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    val endBeforeStart = start != null && end != null && end!! <= start!!
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        val a = c.session.account.value
        if (uri == null || a == null) return@rememberLauncherForActivityResult
        val which = pickWhich
        scope.launch {
            uploading = which
            runCatching {
                val bytes = withContext(Dispatchers.IO) { if (which == "icon") ImageCrop.centerCrop(actx, uri, 1f, 512) else ImageCrop.centerCrop(actx, uri, 2.5f, 1500) }
                val url = org.blossom.uploadPublicImage(a.signer, bytes, eventBlossom = ctx.cfg.blossom)
                if (which == "icon") icon = url else banner = url
            }.onFailure { onError(s.t("create.error.uploadFailed", "reason" to (it.message ?: it.toString()))) }
            uploading = null
        }
    }
    Card {
        Text(s.t("admin.metadata.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.metadata.body"), size = 13)
        Field(title, { title = it }, s.t("create.field.title"))
        Field(summary, { summary = it }, s.t("create.field.summary"), singleLine = false, minLines = 3)
        if (!ctx.isCommunity) {
            DateTimeField(s.t("create.field.start"), start, { start = it })
            DateTimeField(s.t("create.field.end"), end, { end = it }, error = if (endBeforeStart) s.t("create.error.endBeforeStart") else null, minSec = start)
            Field(location, { location = it }, s.t("create.field.location"))
        }
        ImageSlots(title, icon, { icon = it }, banner, { banner = it }, null, null, uploading,
            onPick = { pickWhich = it; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onReset = { icon = ""; banner = "" })
        PrimaryButton(if (busy) s.t("admin.metadata.saving") else s.t("admin.metadata.save"), {
            if (endBeforeStart) { onError(s.t("create.error.endBeforeStart")); return@PrimaryButton }
            busy = true
            scope.launch {
                try {
                    val ok = org.updateMetadata(ctx, Organizer.Metadata(
                        title.trim(), summary.trim(), start, end, location.trim().ifEmpty { null }, icon.trim().ifEmpty { null }, banner.trim().ifEmpty { null },
                    ))
                    c.membership.bump()
                    if (ok) { Toasts.show(s.t("op.eventUpdated")); saved = true } else Toasts.show(s.t("op.eventUpdateQueued"))
                    onSaved()
                } catch (e: Exception) { onError(e.message ?: e.toString()) } finally { busy = false }
            }
        }, enabled = !busy && title.isNotBlank() && (ctx.isCommunity || start != null), busy = busy)
        if (saved) { Dim(s.t("admin.metadata.saved")); LaunchedEffect(Unit) { delay(1500); saved = false } }
    }
}

// ── Menu & layout (31608) ───────────────────────────────────────────────────

private fun <T> move(list: List<T>, i: Int, d: Int): List<T> {
    val to = i + d
    if (to < 0 || to >= list.size) return list
    return list.toMutableList().apply { add(to, removeAt(i)) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PageCard(ctx: EventContext, onError: (String) -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    var menu by remember { mutableStateOf<List<Merged<MenuItem>>>(emptyList()) }
    var sections by remember { mutableStateOf<List<Merged<PageSection>>>(emptyList()) }
    var sources by remember { mutableStateOf<List<ExternalFeed>>(emptyList()) }
    var posts by remember { mutableStateOf<List<Organizer.Post>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    LaunchedEffect(ctx.coordinate) {
        posts = org.cachedPosts(ctx.coordinate)
        org.fetchPage(ctx)?.let { menu = it.menu; sections = it.sections; sources = it.sources }
        loaded = true
        posts = runCatching { org.fetchPosts(ctx) }.getOrDefault(posts)
    }
    fun postNaddr(p: Organizer.Post) = Coordinate(p.kind, ctx.cfg.eidPubkey, p.d).toNaddr(ctx.cfg.relays)
    val pickable = posts.filter { !it.locked }

    var label by remember { mutableStateOf("") }
    var target by remember { mutableStateOf("") }
    var itemMembers by remember { mutableStateOf(false) }
    var pickOpen by remember { mutableStateOf(false) }
    var pinFor by remember { mutableStateOf<Int?>(null) }

    Card {
        Text(s.t("admin.page.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.page.body"), size = 13)
        if (!loaded) { Loading(); return@Card }
        Text(s.t("admin.page.menu"), fontWeight = FontWeight.SemiBold)
        menu.forEachIndexed { i, m ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(m.item.label, fontWeight = FontWeight.Medium)
                    Text(m.item.target, fontSize = 11.sp, color = t.textDim, maxLines = 1)
                }
                if (m.membersOnly) Pill(s.t("post.membersBadge"), t.bgElev2, t.textDim)
                SmallButton("↑", { menu = move(menu, i, -1) })
                SmallButton("↓", { menu = move(menu, i, 1) })
                SmallButton("✕", { menu = menu.filterIndexed { j, _ -> j != i } })
            }
        }
        Field(label, { label = it }, s.t("admin.page.labelPlaceholder"))
        Field(target, { target = it }, s.t("admin.page.targetPlaceholder"))
        if (pickable.isNotEmpty()) {
            Text(s.t("admin.page.pickPost"), Modifier.clickable { pickOpen = !pickOpen }, color = t.accent)
            if (pickOpen) pickable.forEach { p ->
                Text(p.title + if (p.membersOnly) " 🔒" else "", Modifier.clickable {
                    target = "nostr:" + postNaddr(p)
                    if (label.isBlank() && p.title.isNotBlank()) label = p.title
                    if (p.membersOnly) itemMembers = true
                    pickOpen = false
                }.padding(vertical = 6.dp))
            }
        }
        ToggleRow(s.t("admin.page.membersOnlyItem"), itemMembers, { itemMembers = it })
        SmallButton(s.t("admin.page.addItem"), {
            if (label.isNotBlank() && target.isNotBlank()) {
                menu = menu + Merged(MenuItem(label.trim(), target.trim()), itemMembers)
                label = ""; target = ""; itemMembers = false
            }
        })

        Text(s.t("admin.page.sections"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.page.sections.body"), size = 13)
        sections.forEachIndexed { i, m ->
            SoftCard(color = t.bgElev2) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(when (m.item) { is PageSection.Posts -> s.t("admin.page.type.posts"); is PageSection.Pinned -> s.t("admin.page.type.pinned"); is PageSection.Attendees -> s.t("admin.page.type.attendees") },
                        Modifier.weight(1f), fontWeight = FontWeight.Medium)
                    if (m.membersOnly) Pill(s.t("post.membersBadge"), t.bgElev, t.textDim)
                    SmallButton("↑", { sections = move(sections, i, -1) })
                    SmallButton("↓", { sections = move(sections, i, 1) })
                    SmallButton("✕", { sections = sections.filterIndexed { j, _ -> j != i } })
                }
                when (val sec = m.item) {
                    is PageSection.Posts -> {
                        ChoiceField(s.t("posts.filter.source"), listOf("event" to s.t("posts.filter.source.event"), "attendees" to s.t("posts.filter.source.attendees"), "both" to s.t("posts.filter.both")), sec.source,
                            { v -> sections = sections.mapIndexed { j, x -> if (j == i) Merged(sec.copy(source = v), x.membersOnly) else x } })
                        ChoiceField(s.t("posts.filter.visibility"), listOf("public" to s.t("post.editor.public"), "members" to s.t("post.editor.members"), "both" to s.t("posts.filter.both")), sec.visibility,
                            { v -> sections = sections.mapIndexed { j, x -> if (j == i) Merged(sec.copy(visibility = v), x.membersOnly) else x } })
                    }
                    is PageSection.Pinned -> {
                        sec.refs.forEachIndexed { r, ref ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(posts.firstOrNull { "nostr:" + postNaddr(it) == ref || postNaddr(it) == ref }?.title ?: ref.take(24) + "…", Modifier.weight(1f), fontSize = 13.sp)
                                SmallButton("✕", { sections = sections.mapIndexed { j, x -> if (j == i) Merged(sec.copy(refs = sec.refs.filterIndexed { k, _ -> k != r }), x.membersOnly) else x } })
                            }
                        }
                        if (pickable.isNotEmpty()) {
                            Text(s.t("admin.page.pinPost"), Modifier.clickable { pinFor = if (pinFor == i) null else i }, color = t.accent)
                            if (pinFor == i) pickable.forEach { p ->
                                Text(p.title + if (p.membersOnly) " 🔒" else "", Modifier.clickable {
                                    val ref = postNaddr(p)
                                    if (ref !in sec.refs) sections = sections.mapIndexed { j, x -> if (j == i) Merged(sec.copy(refs = sec.refs + ref), x.membersOnly) else x }
                                    pinFor = null
                                }.padding(vertical = 6.dp))
                            }
                        }
                    }
                    is PageSection.Attendees -> Dim(s.t("admin.page.attendees.hint"), size = 13)
                }
                ToggleRow(s.t("admin.page.membersOnlySection"), m.membersOnly, { v -> sections = sections.mapIndexed { j, x -> if (j == i) Merged(x.item, v) else x } })
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallButton("+ " + s.t("admin.page.type.posts"), { sections = sections + Merged(PageSection.Posts("event", "both"), false) })
            SmallButton("+ " + s.t("admin.page.type.pinned"), { sections = sections + Merged(PageSection.Pinned(emptyList()), false) })
            SmallButton("+ " + s.t("admin.page.type.attendees"), { sections = sections + Merged(PageSection.Attendees(), true) })
        }
        FeedsEditor(sources, { sources = it })
        PrimaryButton(if (busy) s.t("admin.page.saving") else s.t("admin.page.save"), {
            busy = true
            scope.launch {
                try {
                    if (org.publishPage(ctx, Organizer.PageModel(menu, sections, sources))) { Toasts.show(s.t("op.pagePublished")); saved = true }
                    else Toasts.show(s.t("op.pageQueued"))
                } catch (e: Exception) { onError(e.message ?: e.toString()) } finally { busy = false }
            }
        }, busy = busy)
        if (saved) { Dim(s.t("admin.page.saved")); LaunchedEffect(Unit) { delay(2000); saved = false } }
    }
}


@Composable
private fun FeedsEditor(sources: List<ExternalFeed>, onChange: (List<ExternalFeed>) -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    var npub by remember { mutableStateOf("") }
    var tags by remember { mutableStateOf("") }
    var since by remember { mutableStateOf("") }
    var relays by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    val fmt = DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(s.locale))
    fun split(raw: String) = raw.split(Regex("[,\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }
    Text(s.t("admin.page.feeds"), fontWeight = FontWeight.SemiBold)
    Dim(s.t("admin.page.feeds.body"), size = 13)
    sources.forEachIndexed { i, f ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            val parts = listOfNotNull(
                f.label?.trim()?.ifEmpty { null } ?: (Nip19.npub(f.pubkey).take(16) + "…"),
                f.tags?.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" },
                f.since?.let { s.t("admin.page.feeds.sinceLabel", "date" to fmt.format(Date(it * 1000))) },
            )
            Column(Modifier.weight(1f)) {
                Text(parts.joinToString(" · "), fontSize = 13.sp)
                f.relays?.takeIf { it.isNotEmpty() }?.let { Text(it.joinToString(", "), fontSize = 11.sp, color = t.textDim, fontFamily = FontFamily.Monospace) }
            }
            SmallButton(s.t("admin.page.feeds.remove"), { onChange(sources.filterIndexed { j, _ -> j != i }) })
        }
    }
    Field(npub, { npub = it; err = null }, s.t("admin.page.feeds.npubPlaceholder"))
    Field(tags, { tags = it }, s.t("admin.page.feeds.tagsPlaceholder"))
    Field(since, { since = it }, s.t("admin.page.feeds.since"), placeholder = "2026-01-31", supporting = s.t("organizer.feeds.sinceFormat"))
    Field(relays, { relays = it }, s.t("admin.page.feeds.relaysPlaceholder"))
    Dim(s.t("admin.page.feeds.relaysHint"), size = 12)
    Field(label, { label = it }, s.t("admin.page.feeds.labelPlaceholder"))
    err?.let { Text(it, color = t.danger, fontSize = 13.sp) }
    SmallButton(s.t("admin.page.feeds.add"), {
        val entry = npub.trim()
        if (entry.isEmpty()) return@SmallButton
        val pk = if (Regex("^[0-9a-fA-F]{64}$").matches(entry)) entry.lowercase() else runCatching { Nip19.decodeNpub(entry) }.getOrNull()
        when {
            pk == null -> err = s.t("admin.page.feeds.badNpub")
            sources.any { it.pubkey == pk } -> err = s.t("admin.page.feeds.duplicate")
            sources.size >= Limits.MAX_FEED_SOURCES -> err = s.t("admin.page.feeds.tooMany", "n" to Limits.MAX_FEED_SOURCES)
            else -> {
                val sinceSec = runCatching { LocalDate.parse(since.trim()).atStartOfDay(ZoneId.systemDefault()).toEpochSecond() }.getOrNull()
                val tagList = split(tags).map { it.removePrefix("#") }.take(Limits.MAX_FEED_TAGS)
                val relayList = split(relays)
                onChange(sources + ExternalFeed(pk, tagList.ifEmpty { null }, sinceSec, null, relayList.ifEmpty { null }, label.trim().ifEmpty { null }))
                npub = ""; tags = ""; since = ""; relays = ""; label = ""
            }
        }
    })
}

// ── Appearance (31609; web-only rendering, so edit + publish here) ──────────

@Composable
private fun ThemeCard(ctx: EventContext, onError: (String) -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    var css by remember { mutableStateOf("") }
    var published by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }
    var restored by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }
    val draftId = "theme:${ctx.coordinate}"
    LaunchedEffect(ctx.coordinate) {
        published = runCatching { org.fetchTheme(ctx) }.getOrDefault("")
        css = published
        org.loadDraft(draftId)?.takeIf { it != published }?.let { css = it; restored = true }
        loaded = true
    }
    LaunchedEffect(css, loaded) {
        if (!loaded) return@LaunchedEffect
        delay(600)
        org.saveDraft(draftId, if (css == published) "" else css)
    }
    val bytes = Bytes.utf8Length(css)
    val over = bytes > EventPage.MAX_THEME_CSS_BYTES
    Card {
        Text(s.t("admin.theme.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.theme.body"), size = 13)
        Dim(s.t("organizer.theme.webOnly"), size = 12)
        if (restored) Row(verticalAlignment = Alignment.CenterVertically) {
            Dim(s.t("draft.restored"), Modifier.weight(1f))
            SmallButton(s.t("draft.discard"), { css = published; restored = false })
        }
        Field(css, { css = it }, s.t("admin.theme.title"), placeholder = s.t("admin.theme.placeholder"), singleLine = false, minLines = 5)
        Text(s.t("admin.theme.byteCount", "used" to bytes, "max" to EventPage.MAX_THEME_CSS_BYTES) + if (over) " · " + s.t("admin.theme.tooBig") else "",
            fontSize = 12.sp, color = if (over) t.danger else t.textDim)
        SmallButton(if (busy) s.t("admin.theme.publishing") else s.t("admin.theme.publish"), {
            busy = true
            scope.launch {
                try {
                    if (org.publishTheme(ctx, css)) { published = css; restored = false; org.saveDraft(draftId, ""); done = true; Toasts.show(s.t("op.themePublished")) }
                    else Toasts.show(s.t("op.themeQueued"))
                } catch (e: Exception) { onError(e.message ?: e.toString()) } finally { busy = false }
            }
        }, enabled = loaded && !busy && !over)
        if (done) { Dim(s.t("admin.theme.published")); LaunchedEffect(Unit) { delay(2000); done = false } }
    }
}

// ── Coordinator lifecycle (UX-A8) ───────────────────────────────────────────

@Composable
private fun CoordinatorSettingsCard(ctx: EventContext, onError: (String) -> Unit, onChanged: () -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    val current = ctx.cfg.coordinator
    var list by remember { mutableStateOf<List<DiscoveredCoordinator>>(emptyList()) }
    var loadingList by remember { mutableStateOf(true) }
    var lastSeen by remember(current) { mutableStateOf<Long?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var attachedOk by remember { mutableStateOf(false) }
    var showReplace by remember { mutableStateOf(false) }
    var confirmDetach by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<Boolean?>(null) }
    var resent by remember { mutableStateOf(false) }
    var paste by remember { mutableStateOf("") }
    LaunchedEffect(current) {
        list = org.cachedCoordinators()
        list = runCatching { org.fetchCoordinators() }.getOrDefault(list)
        loadingList = false
        if (current != null) lastSeen = org.cachedLastSeen(ctx.coordinate) ?: runCatching { org.fetchCoordinatorLastSeen(ctx) }.getOrNull()
    }
    fun run(tag: String, block: suspend () -> Unit) {
        busy = tag
        scope.launch { try { block() } catch (e: Exception) { onError(e.message ?: e.toString()) } finally { busy = null } }
    }
    fun attach(pk: String) = run("attach") { org.attachCoordinator(ctx, pk); attachedOk = true; showReplace = false; onChanged() }

    @Composable
    fun Picker(replace: Boolean) {
        val others = list.filter { it.pubkey != current }
        if (loadingList && others.isEmpty()) Dim(s.t("admin.coordinator.discovering"))
        others.forEach { co ->
            CoordinatorCardView(co, false) {
                SmallButton(if (busy == "attach") s.t("admin.coordinator.attaching") else if (replace) s.t("admin.coordinator.replaceThis") else s.t("admin.coordinator.attachThis"),
                    { attach(co.pubkey) }, enabled = busy == null, selected = true)
            }
        }
        if (others.isNotEmpty()) Dim(s.t("admin.coordinator.unverified"), size = 12)
        Text(s.t("admin.coordinator.paste"), color = t.textDim, fontSize = 13.sp)
        Field(paste, { paste = it }, s.t("admin.coordinator.placeholder"))
        SmallButton(if (busy == "attach") s.t("admin.coordinator.attaching") else if (replace) s.t("admin.coordinator.replace") else s.t("admin.coordinator.attach"), {
            val raw = paste.trim()
            if (raw.startsWith("npub1") && runCatching { Nip19.decodeNpub(raw) }.isFailure) { onError(s.t("admin.error.badNpub")); return@SmallButton }
            val pk = CoordinatorHelpers.parseKey(raw) ?: run { onError(s.t("admin.error.enterNpub")); return@SmallButton }
            attach(pk)
        }, enabled = busy == null && paste.isNotBlank())
    }

    Card {
        Text(s.t("admin.coordinator.title"), fontWeight = FontWeight.SemiBold)
        if (current != null) {
            Text(s.t("admin.coordinator.identity"), fontWeight = FontWeight.Medium)
            val announce = list.firstOrNull { it.pubkey == current }
            if (announce != null) CoordinatorCardView(announce, true) {}
            else Text(Nip19.npub(current).take(24) + "…", fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dim(s.t("admin.coordinator.lastSeen") + " ")
                lastSeen?.let { val (k, n) = AdminModel.sinceLabel(it); Pill(s.t(k, "n" to n), t.okSoft, t.ok) } ?: Pill(s.t("admin.checkingStatus"), t.warnSoft, t.warn)
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SmallButton(if (busy == "test") s.t("admin.coordinator.testing") else s.t("admin.coordinator.test"), {
                    run("test") {
                        val fresh = runCatching { org.fetchCoordinators(force = true) }.getOrDefault(list).also { list = it }
                        val seen = runCatching { org.fetchCoordinatorLastSeen(ctx) }.getOrNull()?.also { lastSeen = it }
                        org.keysFor(ctx.coordinate)?.let { k -> runCatching { org.fetchCoordinatorStatuses(ctx, k) } }
                        testResult = fresh.any { it.pubkey == current } || seen != null
                    }
                }, enabled = busy == null)
                SmallButton(if (busy == "resend") s.t("admin.coordinator.resending") else s.t("admin.coordinator.resend"), {
                    run("resend") { org.attachCoordinator(ctx, current); resent = true; onChanged() }
                }, enabled = busy == null)
                SmallButton(s.t("admin.coordinator.replace"), { showReplace = !showReplace }, selected = showReplace)
            }
            testResult?.let { Dim(if (it) s.t("admin.coordinator.testOk") else s.t("admin.coordinator.testFail")) }
            if (resent) { Dim(s.t("admin.coordinator.resent")); LaunchedEffect(Unit) { delay(2000); resent = false } }
            if (showReplace) SoftCard(color = t.bgElev2) { Dim(s.t("admin.coordinator.replace.body"), size = 13); Picker(replace = true) }
            if (confirmDetach) {
                Dim(s.t("admin.coordinator.detach.consequence"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SmallButton(if (busy == "detach") s.t("admin.coordinator.detaching") else s.t("admin.coordinator.detach.confirm"), {
                        confirmDetach = false
                        run("detach") { org.detachCoordinator(ctx); onChanged() }
                    }, enabled = busy == null)
                    SmallButton(s.t("admin.revoke.keep"), { confirmDetach = false })
                }
            } else SmallButton(s.t("admin.coordinator.detach"), { confirmDetach = true }, enabled = busy == null)
        } else if (attachedOk) {
            Dim(s.t("admin.coordinator.attachedOk"))
        } else {
            Dim(s.t("admin.coordinator.body"), size = 13)
            Picker(replace = false)
        }
    }
}
