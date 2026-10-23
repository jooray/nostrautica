package today.cypherpunk.nostrautica.ui.shell

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.nostr.OutboxView
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.Divider
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/**
 * components/OutboxIndicator.svelte (audit UX-15, App-8): a quiet "waiting to send"
 * chip while the signed-in account has unsent publishes, a red "couldn't be sent"
 * one once something exhausted its retries. Tapping it opens the sync status: each
 * item with its kind, queued time and retries, retry for failed ones and a
 * two-tap discard for all (DS41-021). Renders nothing when the outbox is empty.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OutboxIndicator() {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val owner = account?.pubkey
    val state by remember(owner) {
        if (owner == null) flowOf(OutboxView.EMPTY) else c.nostr.observeUnsent(owner).map { OutboxView.of(it) }
    }.collectAsState(OutboxView.EMPTY)
    var open by remember { mutableStateOf(false) }
    // Discard deletes the durable row for good: the first tap arms that one item.
    var armed by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.isEmpty) { if (state.isEmpty) { open = false; armed = null } }
    if (state.isEmpty) return

    val failed = state.failed.isNotEmpty()
    val color = if (failed) t.danger else t.textDim
    Text(
        if (failed) s.tp("outbox.failed", state.failed.size) else s.tp("outbox.pending", state.pending.size),
        Modifier.padding(end = 8.dp).clip(RoundedCornerShape(999.dp)).border(1.dp, if (failed) t.danger else t.border, RoundedCornerShape(999.dp))
            .clickable(role = Role.Button) { open = true }.padding(horizontal = 10.dp, vertical = 4.dp),
        color = color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
    )

    if (open) {
        val close = { open = false; armed = null }
        ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = t.bg) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(s.t("outbox.syncStatus"), fontWeight = FontWeight.Bold, fontSize = 20.sp)
                val time = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.forLanguageTag(s.locale))
                @Composable
                fun ItemRow(item: OutboxView.Item, retry: Boolean) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val meta = buildList {
                            add(s.t(OutboxView.kindKey(item.kind)))
                            add(time.format(Date(item.queuedAt)))
                            if (retry || item.attempts > 0) add(s.tp("outbox.retries", item.attempts))
                        }.joinToString(" · ")
                        Text(meta, fontSize = 14.sp)
                        if (retry) Dim(s.t("outbox.item", "kind" to item.kind), size = 12)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (retry) SmallButton(s.t("outbox.retry"), { scope.launch { runCatching { c.nostr.retry(item.id) } } })
                            SmallButton(if (armed == item.id) s.t("outbox.discardConfirm") else s.t("outbox.discard"), {
                                if (armed != item.id) armed = item.id
                                else { armed = null; scope.launch { runCatching { c.nostr.discard(item.id) } } }
                            })
                        }
                    }
                }
                if (state.failed.isNotEmpty()) Card {
                    Text(s.t("outbox.failed.title"), fontWeight = FontWeight.SemiBold, color = t.danger)
                    state.failed.forEachIndexed { i, item -> if (i > 0) Divider(); ItemRow(item, retry = true) }
                }
                if (state.pending.isNotEmpty()) Card {
                    Text(s.t("outbox.waiting.title"), fontWeight = FontWeight.SemiBold)
                    state.pending.forEachIndexed { i, item -> if (i > 0) Divider(); ItemRow(item, retry = false) }
                }
            }
        }
    }
}
