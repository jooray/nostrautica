package today.cypherpunk.nostrautica.ui.screens.dm

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.ProfileMeta
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.dm.DmMessage
import today.cypherpunk.nostrautica.domain.dm.DmLogic
import today.cypherpunk.nostrautica.domain.dm.DmPeer
import today.cypherpunk.nostrautica.domain.dm.SharedEvent
import today.cypherpunk.nostrautica.domain.dm.UnreadableMuteList
import today.cypherpunk.nostrautica.domain.dm.dms
import today.cypherpunk.nostrautica.i18n.I18n
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Body
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.IconSquare
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.EventIcon
import today.cypherpunk.nostrautica.ui.shell.GlobalScaffold
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ── Helpers ─────────────────────────────────────────────────────────────────

private fun shortNpub(pubkey: String) = runCatching { Nip19.npub(pubkey) }.getOrDefault(pubkey).take(12) + "…"

private fun nameOf(profiles: Map<String, ProfileMeta>, pubkey: String) = profiles[pubkey]?.name ?: shortNpub(pubkey)

private fun fmt(at: Long, locale: String, skeleton: String): String {
    val loc = Locale.forLanguageTag(locale)
    val pattern = android.text.format.DateFormat.getBestDateTimePattern(loc, skeleton)
    return SimpleDateFormat(pattern, loc).format(Date(at * 1000))
}

/** A message key carried in an exception (the app's convention), else the generic category. */
private fun errorText(s: I18n.Strings, e: Throwable): String =
    e.message?.takeIf { it.contains('.') && s.has(it) }?.let { s.t(it) } ?: s.t("error.cat.generic")

@Composable
private fun rememberProfiles(pubkeys: List<String>): Map<String, ProfileMeta> {
    val c = LocalContainer.current
    val flow = remember(pubkeys) { c.profiles.observe(pubkeys) }
    val profiles by flow.collectAsState(emptyMap())
    LaunchedEffect(pubkeys) { runCatching { c.profiles.refresh(pubkeys) } }
    return profiles
}

@Composable
private fun CountBadge(n: Int, description: String) {
    Text(
        if (n > 99) "99+" else n.toString(),
        Modifier.clip(CircleShape).background(LocalTokens.current.danger).padding(horizontal = 7.dp, vertical = 2.dp).semantics { contentDescription = description },
        color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun LoginCard(body: String, button: String) {
    val router = LocalRouter.current
    Card {
        Body(body)
        PrimaryButton(button, { router.go(Route.Login()) })
    }
}

// ── Messages: group chats + DM threads (pages/Dm.svelte) ─────────────────────

private data class GroupChat(val naddr: String, val coordinate: String, val title: String, val icon: String?, val role: Role)

@Composable
fun DmListScreen() {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val account by c.session.account.collectAsState()
    GlobalScaffold { p ->
        val a = account
        if (a == null) Page(p) {
            item { ScreenTitle(s.t("nav.chat")) }
            item { LoginCard(s.t("dm.loginToSee"), s.t("dm.login")) }
        } else DmList(p, a)
    }
}

@Composable
private fun DmList(p: PaddingValues, account: Session.Account) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val dms = c.dms
    val messages by dms.messages.collectAsState()
    val muted by dms.mutes.muted.collectAsState()
    val unread by dms.unreadByPeer.collectAsState()
    val activity by dms.hasEncryptedActivity.collectAsState()
    val online by c.nostr.network.collectAsState()
    val membershipVersion by c.membership.version.collectAsState()
    var settled by remember { mutableStateOf(false) }

    // One live inbox subscription while this screen is visible; nothing after.
    LaunchedEffect(account.pubkey) { dms.watch { settled = true } }
    LaunchedEffect(Unit) { delay(12_000); settled = true }
    DisposableEffect(Unit) { onDispose { dms.flushReadState() } }

    val threads = remember(messages) { DmLogic.threadsOf(messages) }
    val visible = remember(threads, muted) { threads.filter { it.peer !in muted } }
    val profiles = rememberProfiles(remember(threads) { threads.map { it.peer } })
    // Group chats: visited events the user belongs to, with chat on. Cache only — never blocks the list.
    val groups by produceState(emptyList<GroupChat>(), account.pubkey, membershipVersion) {
        // The same sources as Home (held keys, joins, recently opened), so a chat
        // shows here after a re-login even before its event is opened again.
        value = today.cypherpunk.nostrautica.ui.screens.loadHomeEvents(c, account).mapNotNull { e ->
            if (e.role != Role.ATTENDEE && e.role != Role.ORGANIZER) return@mapNotNull null
            val ctx: EventContext = e.ctx ?: return@mapNotNull null
            if (!ctx.cfg.isMarmotChatEnabled) return@mapNotNull null
            GroupChat(e.naddr, e.coordinate, ctx.title, ctx.icon, e.role)
        }
    }
    val loading = messages.isEmpty() && !settled

    Page(p) {
        item { ScreenTitle(s.t("nav.chat")) }
        if (!online) item { SoftCard(color = t.warnSoft) { Text(s.t("app.android.offlineCached")) } }
        if (groups.isNotEmpty()) {
            item { SectionTitle(s.t("chats.groupSection")) }
            items(groups, key = { "g:" + it.naddr }) { g ->
                Card(onClick = { router.go(Route.Chat(g.naddr)) }, padding = 14.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        EventIcon(g.coordinate, g.icon, g.title)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(g.title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Pill(s.t(if (g.role == Role.ORGANIZER) "home.role.organizer" else "home.role.attendee"), t.bgElev2, t.textDim)
                        }
                        Text("›", color = t.textDim, fontSize = 20.sp)
                    }
                }
            }
        }
        item {
            SectionTitle(s.t("chats.dmSection"), trailing = if (unread.isNotEmpty() || activity) ({
                SmallButton(s.t("dm.markAllRead"), { dms.markAllRead() })
            }) else null)
        }
        when {
            loading -> item { Dim(s.t("dm.decrypting")) }
            visible.isEmpty() -> item {
                Card {
                    if (activity) Dim(s.t("dm.encryptedActivity"))
                    Dim(s.t("dm.empty"))
                }
            }
            else -> {
                if (activity) item { Dim(s.t("dm.encryptedActivity")) }
                items(visible, key = { it.peer }) { th ->
                    val name = nameOf(profiles, th.peer)
                    val n = unread[th.peer] ?: 0
                    Card(onClick = { router.go(Route.DmPeer(Nip19.npub(th.peer))) }, padding = 14.dp) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(th.peer, profiles[th.peer]?.name, profiles[th.peer]?.picture, 44.dp)
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(name, Modifier.weight(1f), fontWeight = if (n > 0) FontWeight.Bold else FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Dim(fmt(th.last.at, s.locale, "MMMdjmm"), size = 12)
                                }
                                Dim((if (th.last.from == th.peer) "" else s.t("dm.youPrefix")) + th.last.text, maxLines = 1)
                            }
                            if (n > 0) { Spacer(Modifier.width(8.dp)); CountBadge(n, s.tp("dm.unread", n)) }
                        }
                    }
                }
            }
        }
    }
}

// ── One conversation (pages/DmChat.svelte) ───────────────────────────────────

@Composable
fun DmThreadScreen(r: Route.DmPeer) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val router = LocalRouter.current
    val account by c.session.account.collectAsState()
    val peer = remember(r.npub) { Nip19.pubkeyFrom(r.npub) }
    GlobalScaffold(back = s.t("nav.back") to { if (!router.back()) router.resetTo(Route.Dm) }) { p ->
        val a = account
        when {
            a == null -> Page(p) { item { LoginCard(s.t("dmchat.loginToSend"), s.t("dmchat.login")) } }
            peer == null -> Page(p) { item { SoftCard(color = LocalTokens.current.warnSoft) { Text(s.t("dmchat.invalidLink")) } } }
            else -> DmThread(p, a, peer)
        }
    }
}

@Composable
private fun DmThread(p: PaddingValues, account: Session.Account, peer: String) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val scope = rememberCoroutineScope()
    val dms = c.dms
    val me = account.pubkey
    val all by dms.messages.collectAsState()
    val outbox by dms.outbox.collectAsState()
    val mutedSet by dms.mutes.muted.collectAsState()
    val muteUnreadable by dms.mutes.unreadable.collectAsState()
    val muted = peer in mutedSet
    val messages = remember(all, peer) { all.filter { it.peer == peer } }
    val profile = rememberProfiles(remember(peer) { listOf(peer) })[peer]
    val title = profile?.name ?: shortNpub(peer)
    var settled by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var draftReady by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var sendSlow by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var muteBusy by remember { mutableStateOf(false) }

    LaunchedEffect(me) { dms.watch { settled = true } }
    LaunchedEffect(Unit) { delay(12_000); settled = true }
    DisposableEffect(Unit) { onDispose { dms.flushReadState() } }

    // Draft: an "Introduce us" prefill wins, else what was left here last time.
    LaunchedEffect(peer) {
        draft = dms.takePrefill(peer) ?: dms.loadDraft(peer) ?: ""
        draftReady = true
    }
    LaunchedEffect(draft) {
        if (!draftReady) return@LaunchedEffect
        delay(500)
        dms.saveDraft(peer, draft)
    }

    // Read while visible: the newest incoming message, whenever it changes and the screen is resumed.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifeState by lifecycle.currentStateFlow.collectAsState()
    val newestId = messages.lastOrNull()?.id
    LaunchedEffect(newestId, lifeState) {
        if (lifeState.isAtLeast(Lifecycle.State.RESUMED)) dms.markThreadRead(peer)
    }

    // Header context: shared events, want-to-meet, follow.
    val shared by produceState(emptyList<SharedEvent>(), peer) { value = runCatching { DmPeer.sharedEvents(c, me, peer) }.getOrDefault(emptyList()) }
    val primary = remember(shared) { DmPeer.primary(shared) }
    var actionCtx by remember { mutableStateOf<EventContext?>(null) }
    var settings by remember { mutableStateOf<PerEventSettings?>(null) }
    var meetBusy by remember { mutableStateOf(false) }
    LaunchedEffect(primary?.naddr) {
        val pe = primary ?: return@LaunchedEffect
        runCatching {
            val ctx = c.contexts.get(pe.naddr)
            actionCtx = ctx
            settings = DmPeer.cachedSettings(c, me, ctx.coordinate) ?: settings
            settings = DmPeer.loadSettings(c, account.signer, ctx)
        }
    }
    var following by remember { mutableStateOf(false) }
    var followsKnown by remember { mutableStateOf(false) }
    var followBusy by remember { mutableStateOf(false) }
    LaunchedEffect(peer) {
        following = peer in c.social.following()
        if (c.nostr.store.latest(Kinds.CONTACTS, me) != null) followsKnown = true
        runCatching { c.social.followTags() }.onSuccess { tags ->
            following = tags.any { it.size >= 2 && it[0] == "p" && it[1] == peer }
            followsKnown = true
        }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty() || sending) return
        sending = true; sendSlow = false; error = null
        scope.launch {
            val slow = launch { delay(6_000); sendSlow = true }
            try {
                dms.send(peer, text)
                draft = ""
                dms.saveDraft(peer, "")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = errorText(s, e)
            } finally {
                slow.cancel(); sendSlow = false; sending = false
            }
        }
    }

    val list = rememberLazyListState()
    LaunchedEffect(newestId) { if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0) }

    Column(Modifier.fillMaxSize().padding(p).consumeWindowInsets(p).imePadding()) {
        // Header: who, and the same quick actions a People row offers.
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(peer, profile?.name, profile?.picture, 40.dp)
                Spacer(Modifier.width(12.dp))
                Text(title, Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (peer != me) {
                    if (primary != null) {
                        val wants = settings?.wantToMeet?.contains(peer) == true
                        IconSquare(
                            if (wants) Icons.Outlined.Bookmark else Icons.Outlined.BookmarkBorder,
                            s.t("dmchat.wantToMeetAt", "event" to primary.title),
                            {
                                val ctx = actionCtx
                                if (ctx != null && !meetBusy) scope.launch {
                                    meetBusy = true
                                    runCatching { DmPeer.toggleWantToMeet(c, account.signer, ctx, peer) }
                                        .onSuccess { settings = it }.onFailure { error = errorText(s, it) }
                                    meetBusy = false
                                }
                            },
                            highlighted = wants,
                        )
                        IconSquare(Icons.Outlined.Person, s.t("dmchat.openProfileAt", "event" to primary.title), {
                            router.go(Route.Attendee(primary.naddr, Nip19.npub(peer)))
                        })
                    }
                    if (followsKnown) {
                        val hint = if (following) s.t("follow.unfollowName", "name" to title) else s.t("follow.followName", "name" to title)
                        SmallButton(
                            if (following) s.t("follow.following") else s.t("follow.notFollowing"),
                            {
                                if (!followBusy) scope.launch {
                                    followBusy = true
                                    runCatching { if (following) c.social.unfollow(peer) else c.social.follow(peer) }
                                        .onSuccess { following = !following }
                                        .onFailure { Toasts.show(errorText(s, it)) }
                                    followBusy = false
                                }
                            },
                            Modifier.semantics { contentDescription = hint },
                            selected = following,
                            enabled = !followBusy,
                        )
                    }
                }
                SmallButton(if (muted) s.t("attendee.unmute") else s.t("attendee.mute"), {
                    if (!muteBusy) scope.launch {
                        muteBusy = true
                        runCatching { dms.mutes.toggle(account.signer, peer) }
                            .onFailure { error = if (it is UnreadableMuteList) s.t("mute.unreadable") else errorText(s, it) }
                        muteBusy = false
                    }
                }, enabled = !muteBusy)
            }
        }

        // Transcript, newest at the bottom; the context notes scroll away above the oldest message.
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val bubbleMax = maxWidth * 0.8f
            LazyColumn(
                Modifier.fillMaxSize(),
                state = list,
                reverseLayout = true,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(messages.asReversed(), key = { it.id }) { m ->
                    Bubble(m, me, outbox, bubbleMax.value, onRetry = { id -> scope.launch { c.nostr.retry(id) } })
                }
                if (messages.isEmpty()) item { Dim(if (!settled) s.t("dmchat.decrypting") else s.t("dmchat.empty")) }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Dim(s.t("dmchat.e2e"), size = 13)
                        if (shared.isNotEmpty()) SharedEventsLine(shared) { router.go(Route.Event(it.naddr)) }
                        if (muted) Dim(s.t("mute.confirm"), size = 13)
                        if (muteUnreadable && muted) Dim(s.t("mute.unreadable"), size = 13)
                    }
                }
            }
        }

        // Composer, pinned above the keyboard.
        Column(Modifier.fillMaxWidth().background(t.bg).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            error?.let { ErrorCard(it) }
            if (sendSlow) Dim(s.t("dmchat.signerSlow"), size = 13)
            Row(verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    draft, { draft = it }, Modifier.weight(1f).heightIn(min = 48.dp),
                    placeholder = { Text(s.t("dmchat.placeholder"), color = t.textDim) },
                    maxLines = 6,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    shape = RoundedCornerShape(10.dp),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = t.border, focusedBorderColor = t.accent, unfocusedContainerColor = t.bgElev, focusedContainerColor = t.bgElev),
                )
                Spacer(Modifier.width(8.dp))
                Button(
                    ::send, Modifier.heightIn(min = 48.dp), enabled = !sending && draft.isNotBlank(),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = t.accentBg, contentColor = t.accentContrast),
                ) {
                    if (sending) CircularProgressIndicator(Modifier.width(18.dp), color = t.accentContrast, strokeWidth = 2.dp)
                    else Text(s.t("dmchat.send"), fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun Bubble(m: DmMessage, me: String, outbox: Map<String, Boolean>, maxWidthDp: Float, onRetry: (String) -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val mine = m.from == me
    val failed = m.outWrap?.let { outbox[it] } == true
    val queued = m.outWrap != null && m.outWrap in outbox
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.widthIn(max = maxWidthDp.dp).clip(RoundedCornerShape(12.dp))
                .background(if (mine) t.accentSoft else t.bgElev2)
                .let { if (failed) it.clickable { onRetry(m.outWrap!!) } else it }
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            SelectionContainer { Text(m.text, fontSize = 15.sp, lineHeight = 21.sp) }
            val time = fmt(m.at, s.locale, "jmm")
            val status = when {
                failed -> s.t("dm.android.failed") + " · "
                queued -> s.t("dmchat.queued") + " · "
                else -> ""
            }
            Text(status + time, Modifier.align(Alignment.End), color = if (failed) t.danger else t.textDim, fontSize = 11.sp)
        }
    }
}

@Composable
private fun SharedEventsLine(events: List<SharedEvent>, onOpen: (SharedEvent) -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
        Dim(s.t("dmchat.sharedEvents") + " ", size = 13)
        events.forEachIndexed { i, e ->
            if (i > 0) Dim(", ", size = 13)
            Text(
                e.title, Modifier.clickable { onOpen(e) }, color = t.accent, fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold, textDecoration = TextDecoration.Underline, maxLines = 1,
            )
        }
    }
}
