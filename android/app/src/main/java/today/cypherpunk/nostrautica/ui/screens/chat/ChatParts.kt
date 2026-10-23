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
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import today.cypherpunk.nostrautica.domain.chat.ChatMembers
import today.cypherpunk.nostrautica.domain.chat.ChatMessage
import today.cypherpunk.nostrautica.domain.chat.DmCommand
import today.cypherpunk.nostrautica.domain.chat.Mentions
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun IrcLine(
    m: ChatMessage,
    name: String,
    account: String,
    locale: String,
    mentions: MentionLook,
    actions: MessageMenuActions,
    editing: Boolean,
    onNick: () -> Unit,
) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    var menu by remember { mutableStateOf(false) }
    val hue = avatarHues(account).first
    val nickColor = hsl(hue, 0.6f, if (t.dark) 0.7f else 0.4f)
    val text = buildAnnotatedString {
        withStyle(SpanStyle(color = t.textDim)) { append(timeLabel(m.at, locale)); append(" ") }
        withStyle(SpanStyle(color = nickColor, fontWeight = FontWeight.SemiBold)) { append("<$name>") }
        append(" ")
        if (m.deleted) withStyle(SpanStyle(color = t.textDim, fontStyle = FontStyle.Italic)) { append(s.t("chat.deleted")) }
        else appendMentions(mentions.segments(m.text), mentions, t.accent, t.warnSoft, avatars = false)
        if (m.edited && !m.deleted) withStyle(SpanStyle(color = t.textDim, fontSize = 11.sp)) { append(" (${s.t("chat.edited")})") }
        m.reactions.forEach { r -> withStyle(SpanStyle(color = t.textDim, fontSize = 12.sp)) { append("  ${r.emoji}${r.count}") } }
    }
    Box {
        Text(
            text,
            Modifier.fillMaxWidth()
                .background(if (editing) t.accentSoft else Color.Transparent)
                .combinedClickable(onClick = onNick, onLongClick = { if (!m.deleted) menu = true })
                .padding(vertical = 1.dp),
            fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 18.sp,
        )
        MessageMenu(menu, { menu = false }, name, actions, onProfile = onNick)
    }
}

/**
 * What the long-press menu can do with one line. Edit and Delete are null on
 * anyone else's message, and on your own once it is deleted
 * ([today.cypherpunk.nostrautica.domain.chat.MessageActions.canModify]).
 */
internal class MessageMenuActions(
    val onReact: (String) -> Unit,
    val onEdit: (() -> Unit)?,
    val onDelete: (() -> Unit)?,
)

/** Quick reactions, then the person's profile, then Edit/Delete on your own line. */
@Composable
private fun MessageMenu(open: Boolean, onDismiss: () -> Unit, name: String, actions: MessageMenuActions, onProfile: () -> Unit) {
    val s = LocalStrings.current
    DropdownMenu(open, onDismiss) {
        Row(Modifier.padding(horizontal = 8.dp)) {
            QUICK_REACTIONS.forEach { e ->
                Text(e, Modifier.clip(RoundedCornerShape(8.dp)).clickable { onDismiss(); actions.onReact(e) }.padding(8.dp), fontSize = 20.sp)
            }
        }
        DropdownMenuItem(text = { Text(s.t("chat.openProfileOf", "name" to name)) }, onClick = { onDismiss(); onProfile() })
        actions.onEdit?.let { edit -> DropdownMenuItem(text = { Text(s.t("chat.edit")) }, onClick = { onDismiss(); edit() }) }
        actions.onDelete?.let { del -> DropdownMenuItem(text = { Text(s.t("chat.delete")) }, onClick = { onDismiss(); del() }) }
    }
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
    mentions: MentionLook,
    actions: MessageMenuActions,
    editing: Boolean,
    onProfile: () -> Unit,
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
                        .then(if (editing) Modifier.border(2.dp, t.accent, RoundedCornerShape(14.dp)) else Modifier)
                        .combinedClickable(onClick = { if (!mine) onProfile() }, onLongClick = { if (!m.deleted) menu = true })
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    if (m.deleted) Text(s.t("chat.deleted"), color = t.textDim, fontStyle = FontStyle.Italic, fontSize = 15.sp)
                    else MessageText(m.text, mentions)
                    Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                        if (m.edited && !m.deleted) { Text(s.t("chat.edited"), color = t.textDim, fontSize = 11.sp); Spacer(Modifier.width(6.dp)) }
                        Text(timeLabel(m.at, locale), color = t.textDim, fontSize = 11.sp)
                    }
                }
                MessageMenu(menu, { menu = false }, name, actions, onProfile)
            }
            if (m.reactions.isNotEmpty()) {
                Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    m.reactions.forEach { r ->
                        Text(
                            "${r.emoji} ${r.count}",
                            Modifier.clip(RoundedCornerShape(999.dp))
                                .background(if (r.mine) t.accentSoft else t.bgElev)
                                .border(1.dp, if (r.mine) t.accent else t.border, RoundedCornerShape(999.dp))
                                .clickable { actions.onReact(r.emoji) }
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

// ── mentions ────────────────────────────────────────────────────────────────

/**
 * How the chat names a mentioned pubkey (EventChat.svelte richText). The key is
 * often a chat DEVICE key, since that is what another Marmot client sees as our
 * member, so [account] maps it like a sender. Parsed once per distinct text.
 */
internal class MentionLook(
    val name: (String) -> String,
    val picture: (String) -> String?,
    val account: (String) -> String,
    val isMe: (String) -> Boolean,
    val open: (String) -> Unit,
) {
    private val cache = HashMap<String, List<Mentions.Segment>>()
    fun segments(text: String): List<Mentions.Segment> = cache.getOrPut(text) { Mentions.parse(text) }
}

private fun AnnotatedString.Builder.appendMentions(
    segments: List<Mentions.Segment>,
    look: MentionLook,
    accent: Color,
    meBg: Color,
    avatars: Boolean,
) {
    segments.forEachIndexed { i, seg ->
        when (seg) {
            is Mentions.Segment.Text -> append(seg.value)
            is Mentions.Segment.Mention -> {
                if (avatars) { appendInlineContent("m$i", "@"); append("\u2009") }
                val style = SpanStyle(color = accent, fontWeight = FontWeight.SemiBold, background = if (look.isMe(seg.pubkey)) meBg else Color.Unspecified)
                withLink(LinkAnnotation.Clickable("mention:$i", TextLinkStyles(style)) { look.open(seg.pubkey) }) { append("@" + look.name(seg.pubkey)) }
            }
        }
    }
}

/** Message text with every mention as an inline avatar + name chip; a tap opens that person. */
@Composable
internal fun MessageText(text: String, look: MentionLook) {
    val t = LocalTokens.current
    val segments = look.segments(text)
    if (segments.none { it is Mentions.Segment.Mention }) {
        Text(text, fontSize = 15.sp, lineHeight = 21.sp)
        return
    }
    val avatar = with(LocalDensity.current) { 16.sp.toDp() }
    val inline = segments.withIndex().filter { it.value is Mentions.Segment.Mention }.associate { (i, seg) ->
        val pk = (seg as Mentions.Segment.Mention).pubkey
        "m$i" to InlineTextContent(Placeholder(16.sp, 16.sp, PlaceholderVerticalAlign.TextCenter)) {
            Avatar(look.account(pk), look.name(pk), look.picture(pk), avatar)
        }
    }
    Text(
        buildAnnotatedString { appendMentions(segments, look, t.accent, t.warnSoft, avatars = true) },
        fontSize = 15.sp, lineHeight = 21.sp, inlineContent = inline,
    )
}

/**
 * Shows each `@npub1…` in the composer as `@Name` while the field keeps the
 * literal npub, which is what gets sent and what White Noise reads. Identity
 * equality on purpose: a name that loads later must re-render the draft.
 */
internal class MentionTransformation(private val label: (String) -> String, private val style: SpanStyle) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val d = Mentions.display(text.text, label)
        if (d.chips.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val shown = buildAnnotatedString {
            append(d.text)
            d.chips.forEach { addStyle(style, it.first, it.last + 1) }
        }
        return TransformedText(shown, object : OffsetMapping {
            override fun originalToTransformed(offset: Int) = d.toShown(offset).coerceIn(0, d.text.length)
            override fun transformedToOriginal(offset: Int) = d.toOriginal(offset).coerceIn(0, text.length)
        })
    }
}

/** The `@` picker: people in this chat, filtered by what follows the `@`. */
@Composable
internal fun MentionPicker(matches: List<Mentions.Candidate>, pictureOf: (String) -> String?, onPick: (Mentions.Candidate) -> Unit) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(12.dp)).background(t.bgElev).border(1.dp, t.border, RoundedCornerShape(12.dp))) {
        Dim(s.t("chat.mention.pick"), Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp), size = 12)
        matches.forEach { c ->
            Row(Modifier.fillMaxWidth().clickable { onPick(c) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(c.account, c.name, pictureOf(c.account), 22.dp)
                Spacer(Modifier.width(8.dp))
                Text(c.name, Modifier.weight(1f, fill = false), fontSize = 14.sp, maxLines = 1)
                Spacer(Modifier.width(8.dp))
                // Two people with one display name stay two people.
                Dim(Mentions.shortNpub(c.account), size = 12)
            }
        }
    }
}
