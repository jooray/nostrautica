package today.cypherpunk.nostrautica.ui.screens.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.ProfileMeta
import today.cypherpunk.nostrautica.domain.chat.ChatMembers
import today.cypherpunk.nostrautica.domain.chat.ChatMessage
import today.cypherpunk.nostrautica.domain.chat.ChatSession
import today.cypherpunk.nostrautica.domain.chat.DmCommand
import today.cypherpunk.nostrautica.domain.chat.ExternalLink
import today.cypherpunk.nostrautica.domain.chat.chat
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * The event's Marmot group chat (EventChat.svelte). Members only (the nav shows
 * the tab only when `showChat`); the MLS runtime runs while this screen is on
 * screen and in the foreground, and closes shortly after it leaves.
 */
@Composable
fun ChatScreen(naddr: String) = EventScaffold(naddr) { p -> ChatBody(naddr, p) }

private const val DISPLAY_MODE_KEY = "chat-display-mode"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatBody(naddr: String, padding: PaddingValues) {
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val acct by c.session.account.collectAsState()
    val account = acct
    if (!ev.showChat || account == null || ev.ctx.cfg.coordinator == null) {
        Page(padding) {
            item { ScreenTitle(s.t("chat.title")) }
            item {
                Card {
                    Dim(s.t("chat.unavailable"))
                    SmallButton(s.t("chat.backToEvent"), { router.switchTo(Route.Event(naddr)) })
                }
            }
        }
        return
    }
    val chat = c.chat
    val session = remember(ev.coordinate, account.pubkey) { chat.session(ev.ctx, account.pubkey) }
    // Run the MLS runtime only while this screen is visible and the app is in front.
    LifecycleStartEffect(session) {
        session.start()
        onStopOrDispose { session.stop() }
    }
    val st by session.state.collectAsState()
    val scope = rememberCoroutineScope()
    val coordinator = ev.ctx.cfg.coordinator

    // ── names ───────────────────────────────────────────────────────────────
    val deviceMap = remember(st.roster) { ChatMembers.deviceAccountMap(st.roster) }
    val memberList = remember(st.roster, st.groupDevices) { ChatMembers.list(st.roster, st.groupDevices, listOfNotNull(coordinator)) }
    val wanted = remember(st.messages, memberList, deviceMap) {
        (st.messages.map { it.sender } + st.messages.map { ChatMembers.accountOf(it.sender, deviceMap) } + memberList.members.map { it.account }).distinct()
    }
    val profiles by remember(wanted) { if (wanted.isEmpty()) flowOf(emptyMap()) else c.profiles.observe(wanted) }.collectAsState(emptyMap<String, ProfileMeta>())
    // Senders the roster can't name yet: their device kind-0 lives on the chat relays only.
    LaunchedEffect(wanted) {
        delay(300)
        val devices = st.messages.map { it.sender }.distinct().filter { it !in deviceMap.values }
        runCatching { c.profiles.refresh(wanted.filter { it in deviceMap.values }) }
        runCatching { c.profiles.refresh(devices, chat.chatRelays(ev.ctx)) }
    }
    fun accountOf(pk: String) = ChatMembers.accountOf(pk, deviceMap)
    fun nameOf(pk: String): String {
        val a = accountOf(pk)
        val raw = (profiles[a]?.name ?: profiles[pk]?.name)?.let(ChatMembers::cleanName)?.takeIf { it.isNotBlank() }
        return raw ?: a.take(8)
    }
    fun pictureOf(pk: String): String? = profiles[accountOf(pk)]?.picture ?: profiles[pk]?.picture
    fun openProfile(pk: String) = router.go(Route.Attendee(naddr, Nip19.npub(accountOf(pk))))

    // ── refusal / setup-slow ────────────────────────────────────────────────
    val setupLike = st.phase == ChatSession.Phase.SETUP || st.phase == ChatSession.Phase.STARTING
    var setupSlow by remember { mutableStateOf(false) }
    LaunchedEffect(setupLike, st.setupSince) {
        setupSlow = false
        if (!setupLike) return@LaunchedEffect
        val wait = ChatSession.SETUP_SLOW_MS - (System.currentTimeMillis() - st.setupSince)
        if (wait > 0) delay(wait)
        setupSlow = true
        chat.scanNotices()
    }
    val refusal by produceState<String?>(null, setupLike, setupSlow) {
        while (setupLike) {
            value = ExternalLink.setupRefusalKey(chat.ownStatuses(account.pubkey, ev.coordinate))?.let { s.t(it) }
            delay(10_000)
        }
        value = null
    }

    // ── composer state ──────────────────────────────────────────────────────
    val draftKey = "chat.draft:${account.pubkey}:${ev.coordinate}"
    var draft by remember { mutableStateOf(c.prefs.getString(draftKey) ?: "") }
    LaunchedEffect(draft) { delay(400); c.prefs.putString(draftKey, draft.takeIf { it.isNotEmpty() }) }
    var sending by remember { mutableStateOf(false) }
    var sendError by remember { mutableStateOf<String?>(null) }
    var sendUnroutable by remember { mutableStateOf(false) }
    var rejoinNote by remember { mutableStateOf<String?>(null) }
    var dmBusy by remember { mutableStateOf(false) }
    var dmError by remember { mutableStateOf<String?>(null) }
    var displayMode by remember { mutableStateOf(c.prefs.getString(DISPLAY_MODE_KEY) ?: "bubbles") }
    var showMembers by remember { mutableStateOf(false) }
    var showDevices by remember { mutableStateOf(false) }

    val me = st.chatPubkey
    val dmTargets = remember(memberList, profiles, me) {
        val myAccount = me?.let(::accountOf)
        memberList.members.map { DmCommand.Target(it.account, nameOf(it.account)) }.filter { it.account != myAccount }.sortedBy { it.name.lowercase() }
    }
    val dmCommand = remember(draft, dmTargets) { DmCommand.parse(draft, dmTargets) }
    val dmMatches = remember(dmCommand, dmTargets) { (dmCommand as? DmCommand.Parsed.Choosing)?.let { DmCommand.match(dmTargets, it.query) } ?: emptyList() }

    fun rejoin() {
        sendError = null; sendUnroutable = false; rejoinNote = null
        scope.launch {
            rejoinNote = runCatching { session.rejoin(force = true) }.fold({ s.t("chat.rejoinRequested") }, { s.t("chat.rejoinFailed") })
        }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty() || sending || dmCommand != null) return
        sending = true; sendError = null; sendUnroutable = false
        scope.launch {
            try {
                session.send(text)
                draft = ""
                rejoinNote = null
            } catch (e: ChatSession.Unroutable) {
                sendUnroutable = true; sendError = s.t("chat.sendFailed")
            } catch (e: Exception) {
                sendError = s.t("chat.sendFailedTransport")
            } finally { sending = false }
        }
    }

    fun runDm(target: DmCommand.Target, body: String) {
        if (dmBusy) return
        dmBusy = true; dmError = null
        scope.launch {
            try {
                if (body.isNotEmpty() && !chat.sendDm(target.account, body)) Toasts.show(s.t("sync.queued"))
                draft = ""
                router.go(Route.DmPeer(Nip19.npub(target.account)))
            } catch (e: Exception) {
                dmError = e.message ?: s.t("chat.devices.actionFailed")
            } finally { dmBusy = false }
        }
    }

    // ── layout ──────────────────────────────────────────────────────────────
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    var unseen by remember { mutableStateOf(false) }
    var painted by remember { mutableStateOf(false) }
    val rows = remember(st.messages, s.locale) { chatRows(st.messages, s.locale) }
    LaunchedEffect(st.messages.lastOrNull()?.id) {
        if (rows.isEmpty()) return@LaunchedEffect
        if (!painted) { listState.scrollToItem(rows.lastIndex); painted = true }
        else if (atBottom || st.messages.lastOrNull()?.sender == me) listState.animateScrollToItem(rows.lastIndex)
        else unseen = true
    }
    LaunchedEffect(atBottom) { if (atBottom) unseen = false }

    Column(
        Modifier.fillMaxSize().padding(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding()).imePadding(),
    ) {
        // Header
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(s.t("chat.title"), fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            Pill(s.t("chat.experimental"), t.bgElev2, t.textDim)
            Spacer(Modifier.weight(1f))
            IconButton({ router.go(Route.Dm) }) { Icon(Icons.Outlined.Forum, s.t("chat.allConversations")) }
            IconButton({ showDevices = true }) { Icon(Icons.Outlined.Devices, s.t("chat.devices.manage.title")) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).clip(RoundedCornerShape(10.dp)).background(t.bgElev).padding(10.dp)) {
            Icon(Icons.Outlined.Info, null, Modifier.size(16.dp), tint = t.textDim)
            Spacer(Modifier.width(8.dp))
            Dim(s.t("chat.disclosure.body"), size = 12)
        }
        if (st.phase == ChatSession.Phase.EVICTED) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                SoftCard(color = t.warnSoft) {
                    Text(s.t("chat.evicted.title"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("chat.evicted.body"))
                    SmallButton(if (st.rejoining) s.t("chat.rejoining") else s.t("chat.rejoin"), ::rejoin, enabled = !st.rejoining)
                }
            }
        }
        // Display mode + members
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallButton(s.t("chat.display.bubbles"), { displayMode = "bubbles"; c.prefs.putString(DISPLAY_MODE_KEY, "bubbles") }, selected = displayMode == "bubbles")
            SmallButton(s.t("chat.display.irc"), { displayMode = "irc"; c.prefs.putString(DISPLAY_MODE_KEY, "irc") }, selected = displayMode == "irc")
            Spacer(Modifier.weight(1f))
            if (memberList.members.isNotEmpty()) {
                Text(
                    "${s.t("chat.members.title")} · ${memberList.members.size}",
                    Modifier.clip(RoundedCornerShape(8.dp)).clickable { showMembers = !showMembers }.padding(6.dp),
                    color = t.textDim, fontSize = 13.sp,
                )
            }
        }
        if (showMembers && memberList.members.isNotEmpty()) {
            MembersList(memberList, ::nameOf, ::pictureOf, ::openProfile, Modifier.padding(horizontal = 16.dp).heightIn(max = 220.dp))
        }

        // Messages
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (st.phase == ChatSession.Phase.ERROR) {
                Column(Modifier.padding(16.dp)) {
                    ErrorCard(s.t("chat.android.startFailed") + (st.error?.let { "\n$it" } ?: ""), { session.retry() }, s.t("chat.retry"))
                }
            } else if (rows.isEmpty()) {
                Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    if (setupLike) {
                        SetupProgress(st, refusal, setupSlow, onRetry = { session.retry() }, onRejoin = ::rejoin)
                    } else {
                        Dim(s.t("chat.empty"))
                    }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (st.hasMoreBefore) item("older") {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            SmallButton(s.t("chat.android.loadOlder"), { scope.launch { session.loadOlder() } })
                        }
                    }
                    items(rows, key = { it.key }) { row ->
                        when (row) {
                            is ChatRow.Day -> DaySeparator(row.label, irc = displayMode == "irc")
                            is ChatRow.Msg -> if (displayMode == "irc") IrcLine(row.m, nameOf(row.m.sender), accountOf(row.m.sender), s.locale) { openProfile(row.m.sender) }
                            else Bubble(
                                m = row.m,
                                mine = row.m.sender == me,
                                showSender = row.showSender,
                                name = nameOf(row.m.sender),
                                picture = pictureOf(row.m.sender),
                                account = accountOf(row.m.sender),
                                locale = s.locale,
                                onProfile = { openProfile(row.m.sender) },
                                onReact = { emoji -> scope.launch { runCatching { session.toggleReaction(row.m, emoji) } } },
                            )
                        }
                    }
                }
                if (setupLike) {
                    // History from before is on screen; still say the room isn't usable yet.
                    Box(Modifier.align(Alignment.TopCenter).padding(8.dp)) { Pill(s.t("chat.setup"), t.warnSoft, t.warn) }
                }
                if (unseen) {
                    Box(Modifier.align(Alignment.BottomCenter).padding(8.dp)) {
                        SmallButton(s.t("chat.jumpToLatest"), { scope.launch { listState.animateScrollToItem(rows.lastIndex); unseen = false } }, selected = true)
                    }
                }
            }
        }

        // /msg picker and hint
        if (dmCommand is DmCommand.Parsed.Choosing && dmMatches.isNotEmpty()) {
            NickPicker(dmMatches, ::pictureOf) { target -> draft = "/msg ${target.name} "; dmError = null }
        }
        if (dmCommand is DmCommand.Parsed.Ready) {
            Dim(
                if (dmCommand.body.isNotEmpty()) s.t("chat.cmd.willSend", "name" to dmCommand.target.name) else s.t("chat.cmd.willOpen", "name" to dmCommand.target.name),
                Modifier.padding(horizontal = 16.dp), size = 12,
            )
        }
        if (dmCommand is DmCommand.Parsed.Choosing && dmMatches.isEmpty() && (dmCommand.query.isNotEmpty())) {
            Dim(s.t("chat.cmd.noSuchPerson"), Modifier.padding(horizontal = 16.dp), size = 12)
        }

        // Composer
        val composerEnabled = st.phase == ChatSession.Phase.READY
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it; dmError = null },
                modifier = Modifier.weight(1f),
                placeholder = { Text(s.t("chat.compose.placeholder"), color = t.textDim) },
                enabled = composerEnabled || draft.startsWith("/"),
                maxLines = 5,
                shape = RoundedCornerShape(20.dp),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = t.border, focusedBorderColor = t.accent, unfocusedContainerColor = t.bgElev, focusedContainerColor = t.bgElev),
            )
            Spacer(Modifier.width(6.dp))
            val canSend = when (val d = dmCommand) {
                is DmCommand.Parsed.Ready -> !dmBusy
                is DmCommand.Parsed.Choosing -> false
                null -> composerEnabled && draft.isNotBlank() && !sending
            }
            IconButton(
                onClick = {
                    when (val d = dmCommand) {
                        is DmCommand.Parsed.Ready -> runDm(d.target, d.body)
                        is DmCommand.Parsed.Choosing -> {}
                        null -> send()
                    }
                },
                enabled = canSend,
            ) {
                if (sending || dmBusy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.AutoMirrored.Filled.Send, if (dmCommand != null) s.t("chat.cmd.pickPerson") else s.t("chat.send"), tint = if (canSend) t.accent else t.textDim)
            }
        }
        dmError?.let { Text(it, Modifier.padding(horizontal = 16.dp), color = t.danger, fontSize = 13.sp) }
        sendError?.let { err ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(err, Modifier.weight(1f), color = t.danger, fontSize = 13.sp)
                if (sendUnroutable) SmallButton(if (st.rejoining) s.t("chat.rejoining") else s.t("chat.rejoin"), ::rejoin, enabled = !st.rejoining)
                else SmallButton(if (sending) s.t("chat.sending") else s.t("chat.sendRetry"), ::send, enabled = !sending)
            }
        }
        rejoinNote?.let { Dim(it, Modifier.padding(horizontal = 16.dp, vertical = 2.dp), size = 12) }
    }

    if (showDevices) {
        ModalBottomSheet(onDismissRequest = { showDevices = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = t.bg) {
            ChatDevicesSheet(session, ev.ctx, account.pubkey)
        }
    }
}

@Composable
private fun SetupProgress(st: ChatSession.State, refusal: String?, slow: Boolean, onRetry: () -> Unit, onRejoin: () -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
            Text(s.t("chat.setup"), fontSize = 15.sp)
        }
        Step(st.keyPackageReady, if (st.keyPackageReady) s.t("chat.android.steps.keyPackage") else s.t("chat.android.steps.keyPackageWaiting"))
        val (done, label) = when (st.attest) {
            ChatSession.Attest.SENT -> true to s.t("chat.android.steps.attest")
            ChatSession.Attest.QUEUED -> false to s.t("chat.android.steps.attestQueued")
            ChatSession.Attest.FAILED -> false to s.t("chat.android.steps.attestFailed")
            ChatSession.Attest.NONE -> false to s.t("chat.android.steps.attestWaiting")
        }
        Step(done, label, error = st.attest == ChatSession.Attest.FAILED)
        Step(false, if (st.unverifiedGroup) s.t("chat.android.steps.unverified") else s.t("chat.android.steps.welcome"))
        if (refusal != null) Text(refusal, color = t.danger, fontSize = 14.sp)
        if (slow) {
            if (refusal == null) Dim(s.t("chat.setupSlow"))
            SmallButton(s.t("chat.retry"), onRetry)
            Dim(s.t("chat.rejoinHint"))
            SecondaryButton(if (st.rejoining) s.t("chat.rejoining") else s.t("chat.rejoin"), onRejoin, enabled = !st.rejoining)
        }
    }
}

@Composable
private fun Step(done: Boolean, label: String, error: Boolean = false) {
    val t = LocalTokens.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(if (done) "✓" else if (error) "!" else "…", Modifier.width(20.dp), color = if (done) t.ok else if (error) t.danger else t.textDim, fontWeight = FontWeight.Bold)
        Text(label, fontSize = 14.sp, color = if (done) t.text else t.textDim)
    }
}

/** The list rows: day separators between messages, sender shown on a change. */
internal sealed interface ChatRow {
    val key: String
    data class Day(val label: String) : ChatRow { override val key get() = "day:$label" }
    data class Msg(val m: ChatMessage, val showSender: Boolean) : ChatRow { override val key get() = m.id }
}

internal fun chatRows(messages: List<ChatMessage>, locale: String): List<ChatRow> {
    val out = ArrayList<ChatRow>()
    var lastDay: String? = null
    var lastSender: String? = null
    for (m in messages) {
        val day = dayLabel(m.at, locale)
        if (day != lastDay) { out += ChatRow.Day(day); lastDay = day; lastSender = null }
        out += ChatRow.Msg(m, m.sender != lastSender)
        lastSender = m.sender
    }
    return out
}
