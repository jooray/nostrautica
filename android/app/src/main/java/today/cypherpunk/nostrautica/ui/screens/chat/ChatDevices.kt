package today.cypherpunk.nostrautica.ui.screens.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.chat.ChatAttest
import today.cypherpunk.nostrautica.domain.chat.ChatDeviceKeys
import today.cypherpunk.nostrautica.domain.chat.ChatMembers
import today.cypherpunk.nostrautica.domain.chat.ChatSession
import today.cypherpunk.nostrautica.domain.chat.ExternalLink
import today.cypherpunk.nostrautica.domain.chat.chat
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/**
 * "Chat devices" (ChatHandoffCard.svelte): this account's attested devices for the
 * event, from the roster's `chat_keys`. This device can be renamed (a re-attest,
 * which needs its own proof of possession, so no other device can be renamed
 * here); any device can be removed (21607 revoke, sealed by the account). The
 * White Noise link card sits underneath, since a linked key is one more device.
 */
@Composable
internal fun ChatDevicesSheet(session: ChatSession, ctx: EventContext, account: String) {
    val c = LocalContainer.current
    val chat = c.chat
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val st by session.state.collectAsState()
    val thisDevice = st.chatPubkey ?: remember(account) { chat.keys.peekPubkey(account) }
    val fromRoster = remember(st.roster) { ChatMembers.devicesFor(st.roster, account) }
    var devices by remember(fromRoster) { mutableStateOf(fromRoster) }
    var loading by remember { mutableStateOf(true) }
    var renaming by remember { mutableStateOf<String?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var confirmRevoke by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { session.refreshRoster(); loading = false }

    fun refreshLater() = scope.launch { delay(4_000); session.refreshRoster() }

    fun saveRename(d: ChatMembers.Device) {
        val label = renameDraft.trim()
        if (label.isEmpty()) return
        busy = d.pubkey; notice = null
        scope.launch {
            try {
                val dev = chat.keys.ensure(account)
                // Remembered first, so every later re-attest carries the user's name, not ours.
                chat.keys.saveLabel(dev.pubkey, label)
                val delivered = chat.attest(ctx, ChatAttest.Op.ADD, dev.pubkey, label, dev.clientId, dev.secret)
                devices = devices.map { if (it.pubkey == d.pubkey) it.copy(label = label) else it }
                notice = s.t(if (delivered) "chat.devices.updated" else "chat.devices.queued")
                renaming = null
            } catch (e: Exception) {
                notice = s.t("chat.devices.actionFailed")
            } finally { busy = null; refreshLater() }
        }
    }

    fun revoke(d: ChatMembers.Device) {
        busy = d.pubkey; notice = null
        scope.launch {
            try {
                val delivered = chat.attest(ctx, ChatAttest.Op.REVOKE, d.pubkey)
                devices = devices.filterNot { it.pubkey == d.pubkey }
                notice = s.t(if (delivered) "chat.devices.updated" else "chat.devices.queued")
                confirmRevoke = null
            } catch (e: Exception) {
                notice = s.t("chat.devices.actionFailed")
            } finally { busy = null; refreshLater() }
        }
    }

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(s.t("chat.devices.manage.title"), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Dim(s.t("chat.devices.manage.body"))
        when {
            loading && devices.isEmpty() -> Dim(s.t("chat.devices.loading"))
            devices.isEmpty() -> Dim(s.t("chat.devices.none"))
            else -> devices.forEach { d ->
                val isThis = d.pubkey == thisDevice
                Card(padding = 14.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.PhoneAndroid, null, Modifier.size(18.dp), tint = t.textDim)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            if (renaming == d.pubkey) {
                                Field(renameDraft, { renameDraft = it.take(60) }, s.t("chat.devices.renameLabel"))
                            } else {
                                Text(d.label?.trim()?.takeIf { it.isNotEmpty() } ?: (d.pubkey.take(12) + "…"), fontWeight = FontWeight.SemiBold)
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    if (isThis) Pill(s.t("chat.devices.thisDevice"), t.accentSoft, t.accent)
                                    if (d.external && d.label != s.t("chat.wn.badge")) Pill(s.t("chat.wn.badge"), t.bgElev2, t.textDim)
                                }
                                Dim(s.t("chat.devices.lastActive", "date" to DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(s.locale)).format(Date(ChatMembers.addedAtMillis(d.addedAt)))), size = 12)
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        when {
                            renaming == d.pubkey -> {
                                SmallButton(s.t("chat.devices.renameSave"), { saveRename(d) }, enabled = renameDraft.isNotBlank() && busy != d.pubkey)
                                SmallButton(s.t("chat.devices.renameCancel"), { renaming = null })
                            }
                            confirmRevoke == d.pubkey -> {
                                Text(s.t("chat.devices.revokeConfirm"), fontSize = 14.sp)
                                SmallButton(s.t("chat.devices.revokeYes"), { revoke(d) }, enabled = busy != d.pubkey)
                                SmallButton(s.t("chat.devices.revokeNo"), { confirmRevoke = null })
                            }
                            else -> {
                                if (isThis) SmallButton(s.t("chat.devices.rename"), { renaming = d.pubkey; renameDraft = d.label ?: ""; confirmRevoke = null }, enabled = busy != d.pubkey)
                                SmallButton(s.t("chat.devices.revoke"), { confirmRevoke = d.pubkey; renaming = null }, enabled = busy != d.pubkey)
                            }
                        }
                    }
                }
            }
        }
        notice?.let { Dim(it, size = 13) }
        WhiteNoiseLinkCard(session, ctx, account)
    }
}

/**
 * "Also chat from White Noise" (WhiteNoiseLinkCard.svelte). idle → waiting for the
 * code (a key other than the account's) → linked. The coordinator does the
 * adding; this asks, then watches the roster (success) and the 21606 `chat_link`
 * notices (refusals).
 */
@Composable
private fun WhiteNoiseLinkCard(session: ChatSession, ctx: EventContext, account: String) {
    val c = LocalContainer.current
    val chat = c.chat
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val st by session.state.collectAsState()
    var phase by remember { mutableStateOf("idle") }
    var input by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var inputError by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var target by remember { mutableStateOf<String?>(null) }
    var since by remember { mutableLongStateOf(0L) }
    var baselineAt by remember { mutableLongStateOf(Long.MIN_VALUE) }
    var statuses by remember { mutableStateOf<List<CoordinatorStatusContent>>(emptyList()) }
    var watcher by remember { mutableStateOf<Job?>(null) }

    LaunchedEffect(account) {
        statuses = chat.ownStatuses(account, ctx.coordinate)
        chat.keys.pendingLink(account, ctx.coordinate)?.let { p ->
            if (phase == "idle") { target = p.chatPubkey; since = p.startedAt; phase = "waiting" }
        }
    }

    fun watch() {
        watcher?.cancel()
        watcher = scope.launch {
            for (ms in listOf(3_000L, 5_000L, 7_000L, 15_000L, 30_000L)) {
                delay(ms)
                chat.scanNotices()
                statuses = chat.ownStatuses(account, ctx.coordinate)
                session.refreshRoster()
            }
        }
    }

    // A linked key shows up in the roster.
    LaunchedEffect(st.roster, target, phase) {
        val w = target ?: return@LaunchedEffect
        if (phase != "idle" && ExternalLink.isLinkedInRoster(st.roster, account, w)) {
            chat.keys.savePendingLink(account, ctx.coordinate, null)
            phase = "linked"
        }
    }

    val linkNotice = if (target != null && phase != "idle" && phase != "sending") ExternalLink.latestNotice(statuses, since, baselineAt) else null
    val refusal = linkNotice?.takeIf { it.state == "poison" }
    LaunchedEffect(refusal) {
        val r = refusal ?: return@LaunchedEffect
        if (phase == "confirming") phase = "waiting"
        if (phase == "linked" || ExternalLink.refusalEndsLink(r.errorCategory)) {
            notice = s.t(ExternalLink.refusalKey(r.errorCategory))
            chat.keys.savePendingLink(account, ctx.coordinate, null)
            phase = "idle"; target = null
        }
    }

    fun startLink() {
        val w = ExternalLink.parsePubkey(input) ?: run { inputError = s.t("chat.wn.invalid"); return }
        inputError = null; notice = null; phase = "sending"
        baselineAt = ExternalLink.newestNoticeAt(statuses)
        scope.launch {
            try {
                val delivered = chat.attest(ctx, ChatAttest.Op.LINK, w, label = ExternalLink.LABEL)
                target = w; since = nowSec()
                if (!delivered) notice = s.t("chat.devices.queued")
                if (w == account) phase = "linked"
                else {
                    chat.keys.savePendingLink(account, ctx.coordinate, ChatDeviceKeys.PendingLink(w, since))
                    code = ""; phase = "waiting"
                }
                watch()
            } catch (e: Exception) {
                phase = "idle"; notice = s.t("chat.wn.failed")
            }
        }
    }

    fun confirm() {
        val w = target ?: return
        if (code.isBlank()) return
        notice = null; phase = "confirming"
        baselineAt = ExternalLink.newestNoticeAt(statuses)
        scope.launch {
            try {
                val delivered = chat.attest(ctx, ChatAttest.Op.LINK_CONFIRM, w, code = code.trim())
                if (!delivered) notice = s.t("chat.devices.queued")
                watch()
            } catch (e: Exception) {
                phase = "waiting"; notice = s.t("chat.wn.failed")
            }
        }
    }

    fun reset() {
        chat.keys.savePendingLink(account, ctx.coordinate, null)
        watcher?.cancel()
        phase = "idle"; target = null; code = ""; input = ""; notice = null
    }

    Card(padding = 14.dp) {
        Text(s.t("chat.wn.title"), fontWeight = FontWeight.SemiBold)
        when (phase) {
            "idle", "sending" -> {
                Dim(s.t("chat.wn.body"), size = 13)
                Field(
                    input, { input = it; inputError = null }, s.t("chat.wn.inputLabel"),
                    placeholder = s.t("chat.wn.inputPlaceholder"), isError = inputError != null, supporting = inputError,
                    keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                )
                PrimaryButton(if (phase == "sending") s.t("chat.wn.sending") else s.t("chat.wn.submit"), ::startLink, enabled = input.isNotBlank(), busy = phase == "sending")
                LinkButton(s.t("chat.wn.useAccount"), { input = Nip19.npub(account); inputError = null })
            }
            "waiting", "confirming" -> {
                Text(s.t("chat.wn.waitingBody"), fontSize = 14.sp)
                Dim(s.t("chat.wn.expiry"), size = 13)
                Field(
                    code, { code = it.take(32) }, s.t("chat.wn.codeLabel"), placeholder = "XXXX-XXXX",
                    keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                )
                PrimaryButton(if (phase == "confirming") s.t("chat.wn.checking") else s.t("chat.wn.confirm"), ::confirm, enabled = code.isNotBlank(), busy = phase == "confirming")
                SmallButton(s.t("chat.wn.cancel"), ::reset)
                refusal?.let { Text(s.t(ExternalLink.refusalKey(it.errorCategory)), color = t.danger, fontSize = 13.sp) }
            }
            else -> {
                Text(s.t("chat.wn.linkedBody"), fontSize = 14.sp)
                SmallButton(s.t("chat.wn.linkAnother"), ::reset)
            }
        }
        notice?.let { Dim(it, size = 13) }
    }
}
