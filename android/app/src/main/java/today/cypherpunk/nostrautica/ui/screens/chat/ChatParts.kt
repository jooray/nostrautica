package today.cypherpunk.nostrautica.ui.screens.chat

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import today.cypherpunk.nostrautica.domain.chat.ChatMembers
import today.cypherpunk.nostrautica.domain.chat.ChatMessage
import today.cypherpunk.nostrautica.domain.chat.DmCommand
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.avatarHues
import today.cypherpunk.nostrautica.ui.components.hsl
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

internal fun dayLabel(sec: Long, locale: String): String =
    DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(locale)).format(Date(sec * 1000))

internal fun timeLabel(sec: Long, locale: String): String =
    DateFormat.getTimeInstance(DateFormat.SHORT, Locale.forLanguageTag(locale)).format(Date(sec * 1000))

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "🎉", "🙏", "👀")

@Composable
internal fun DaySeparator(label: String, irc: Boolean) {
    val t = LocalTokens.current
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(
            label,
            if (irc) Modifier else Modifier.clip(RoundedCornerShape(999.dp)).background(t.bgElev).padding(horizontal = 10.dp, vertical = 2.dp),
            color = t.textDim, fontSize = 12.sp,
        )
    }
}

@Composable
internal fun IrcLine(m: ChatMessage, name: String, account: String, locale: String, onNick: () -> Unit) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    val hue = avatarHues(account).first
    val nickColor = hsl(hue, 0.6f, if (t.dark) 0.7f else 0.4f)
    val text = buildAnnotatedString {
        withStyle(SpanStyle(color = t.textDim)) { append(timeLabel(m.at, locale)); append(" ") }
        withStyle(SpanStyle(color = nickColor, fontWeight = FontWeight.SemiBold)) { append("<$name>") }
        append(" ")
        if (m.deleted) withStyle(SpanStyle(color = t.textDim, fontStyle = FontStyle.Italic)) { append(s.t("chat.android.deleted")) }
        else append(m.text)
        if (m.edited && !m.deleted) withStyle(SpanStyle(color = t.textDim, fontSize = 11.sp)) { append(" (${s.t("chat.android.edited")})") }
        m.reactions.forEach { r -> withStyle(SpanStyle(color = t.textDim, fontSize = 12.sp)) { append("  ${r.emoji}${r.count}") } }
    }
    Text(text, Modifier.fillMaxWidth().clickable(onClick = onNick).padding(vertical = 1.dp), fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 18.sp)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun Bubble(
    m: ChatMessage,
    mine: Boolean,
    showSender: Boolean,
    name: String,
    picture: String?,
    account: String,
    locale: String,
    onProfile: () -> Unit,
    onReact: (String) -> Unit,
) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(top = if (showSender) 6.dp else 0.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!mine) {
            if (showSender) Box(Modifier.clip(RoundedCornerShape(999.dp)).clickable(onClick = onProfile)) { Avatar(account, name, picture, 28.dp) }
            else Spacer(Modifier.width(28.dp))
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start, modifier = Modifier.widthIn(max = 300.dp)) {
            if (showSender && !mine) {
                Text(name, Modifier.clickable(onClick = onProfile).padding(bottom = 2.dp), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = t.textDim)
            }
            Box {
                Column(
                    Modifier
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (mine) t.accentSoft else t.bgElev)
                        .combinedClickable(onClick = { if (!mine) onProfile() }, onLongClick = { if (!m.deleted) menu = true })
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    if (m.deleted) Text(s.t("chat.android.deleted"), color = t.textDim, fontStyle = FontStyle.Italic, fontSize = 15.sp)
                    else Text(m.text, fontSize = 15.sp, lineHeight = 21.sp)
                    Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                        if (m.edited && !m.deleted) { Text(s.t("chat.android.edited"), color = t.textDim, fontSize = 11.sp); Spacer(Modifier.width(6.dp)) }
                        Text(timeLabel(m.at, locale), color = t.textDim, fontSize = 11.sp)
                    }
                }
                DropdownMenu(menu, { menu = false }) {
                    Row(Modifier.padding(horizontal = 8.dp)) {
                        QUICK_REACTIONS.forEach { e ->
                            Text(e, Modifier.clip(RoundedCornerShape(8.dp)).clickable { menu = false; onReact(e) }.padding(8.dp), fontSize = 20.sp)
                        }
                    }
                    DropdownMenuItem(text = { Text(s.t("chat.openProfileOf", "name" to name)) }, onClick = { menu = false; onProfile() })
                }
            }
            if (m.reactions.isNotEmpty()) {
                Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    m.reactions.forEach { r ->
                        Text(
                            "${r.emoji} ${r.count}",
                            Modifier.clip(RoundedCornerShape(999.dp))
                                .background(if (r.mine) t.accentSoft else t.bgElev)
                                .border(1.dp, if (r.mine) t.accent else t.border, RoundedCornerShape(999.dp))
                                .clickable { onReact(r.emoji) }
                                .padding(horizontal = 7.dp, vertical = 1.dp),
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun MembersList(
    list: ChatMembers.MemberList,
    nameOf: (String) -> String,
    pictureOf: (String) -> String?,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(t.bgElev).padding(10.dp)) {
        if (list.source == ChatMembers.Source.ATTESTED) Dim(s.t("chat.members.attested"), size = 12)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(list.members, key = { it.account }) { mem ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(mem.account) }, verticalAlignment = Alignment.CenterVertically) {
                    Avatar(mem.account, nameOf(mem.account), pictureOf(mem.account), 24.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(nameOf(mem.account), Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
                    if (mem.deviceCount > 1) Dim(s.tp("chat.members.devices", mem.deviceCount), size = 12)
                }
            }
        }
    }
}

@Composable
internal fun NickPicker(matches: List<DmCommand.Target>, pictureOf: (String) -> String?, onPick: (DmCommand.Target) -> Unit) {
    val t = LocalTokens.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(12.dp)).background(t.bgElev).border(1.dp, t.border, RoundedCornerShape(12.dp))) {
        matches.forEach { c ->
            Row(Modifier.fillMaxWidth().clickable { onPick(c) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(c.account, c.name, pictureOf(c.account), 22.dp)
                Spacer(Modifier.width(8.dp))
                Text(c.name, fontSize = 14.sp)
            }
        }
    }
}
