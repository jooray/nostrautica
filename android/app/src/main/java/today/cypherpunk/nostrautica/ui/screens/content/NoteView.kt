package today.cypherpunk.nostrautica.ui.screens.content

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import today.cypherpunk.nostrautica.domain.content.NoteTokens
import today.cypherpunk.nostrautica.domain.content.NoteTokens.Token
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * A short Nostr note (PostView.svelte): mentions by name, links, inline images
 * (only with off-origin images allowed; otherwise the address), videos as links
 * out, quoted notes, and the reply's parent above the body. For the attendee
 * page's recent posts; not used by event posts (those are long-form markdown).
 */
@Composable
fun NoteView(note: NostrEvent, modifier: Modifier = Modifier) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    val allowImages by c.prefs.externalImages.collectAsState()
    val tokens = remember(note.id) { NoteTokens.parse(note.content, NoteTokens.imetaUrls(note.tags)) }
    val mentioned = remember(tokens) {
        tokens.filterIsInstance<Token.Mention>().mapNotNull { (NoteTokens.decode(it.bech32) as? NoteTokens.Ref.Profile)?.pubkey }.distinct()
    }
    val names by remember(mentioned) { c.profiles.observe(mentioned) }.collectAsState(emptyMap())
    LaunchedEffect(mentioned) { if (mentioned.isNotEmpty()) runCatching { c.profiles.refresh(mentioned) } }
    val linkStyle = TextLinkStyles(SpanStyle(color = t.accent, fontWeight = FontWeight.SemiBold))

    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Dim(shortDay(note.createdAt, s.locale), size = 12)
        NoteTokens.replyTo(note.tags)?.let { QuotedNote(id = it, label = s.t("post.replyingTo")) }
        val inline = tokens.filter { it is Token.Text || it is Token.Link || it is Token.Mention }
        if (inline.any { it !is Token.Text || it.value.isNotBlank() }) {
            Text(buildAnnotatedString {
                for (tk in inline) when (tk) {
                    is Token.Text -> append(tk.value)
                    is Token.Link -> withLink(LinkAnnotation.Clickable(tk.url, linkStyle) { openExternal(ctx, tk.url) }) { append(tk.url) }
                    is Token.Mention -> {
                        val pk = (NoteTokens.decode(tk.bech32) as? NoteTokens.Ref.Profile)?.pubkey
                        val label = pk?.let { names[it]?.name }?.let { "@$it" } ?: ("@" + tk.bech32.take(10) + "…")
                        withLink(LinkAnnotation.Clickable(tk.bech32, linkStyle) { openExternal(ctx, "nostr:" + tk.bech32) }) { append(label) }
                    }
                    else -> Unit
                }
            }, fontSize = 15.sp, lineHeight = 22.sp)
        }
        for (tk in tokens) when (tk) {
            is Token.Image -> if (allowImages && tk.url.startsWith("https://")) {
                AsyncImage(tk.url, null, Modifier.fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.FillWidth)
            } else LinkText(tk.url)
            is Token.Video -> LinkText(tk.url)
            is Token.Embed -> QuotedNote(bech32 = tk.bech32)
            else -> Unit
        }
    }
}

@Composable
private fun LinkText(url: String) {
    val ctx = LocalContext.current
    val t = LocalTokens.current
    Text(
        buildAnnotatedString { withLink(LinkAnnotation.Clickable(url, TextLinkStyles(SpanStyle(color = t.accent))) { openExternal(ctx, url) }) { append(url) } },
        fontSize = 13.sp,
    )
}

/**
 * A compact quoted note (QuotedNote.svelte): resolves a note/nevent/naddr (or a
 * raw id for a reply's parent) from the phone, then relays; never recurses into
 * further embeds, so a quote of a quote can't loop.
 */
@Composable
fun QuotedNote(bech32: String? = null, id: String? = null, label: String? = null) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val allowImages by c.prefs.externalImages.collectAsState()
    val ev by produceState<Result<NostrEvent?>?>(null, bech32, id) {
        value = runCatching {
            val ref = id?.let { NoteTokens.Ref.Event(it, emptyList()) } ?: bech32?.let(NoteTokens::decode)
            val filter = when (ref) {
                is NoteTokens.Ref.Event -> Filter(ids = listOf(ref.id))
                is NoteTokens.Ref.Address -> Filter(kinds = listOf(ref.kind), authors = listOf(ref.pubkey), tags = mapOf("d" to listOf(ref.d)))
                else -> null
            } ?: return@runCatching null
            c.nostr.local(filter).firstOrNull() ?: run {
                val relays = Relays.READ + when (ref) { is NoteTokens.Ref.Event -> ref.relays; is NoteTokens.Ref.Address -> ref.relays; else -> emptyList() }
                c.nostr.fetch(relays.take(Relays.READ.size + 3), filter)
                c.nostr.local(filter).firstOrNull()
            }
        }
    }
    val note = ev?.getOrNull()
    val prof by remember(note?.pubkey) { c.profiles.observe(listOfNotNull(note?.pubkey)) }.collectAsState(emptyMap())
    LaunchedEffect(note?.pubkey) { note?.pubkey?.let { runCatching { c.profiles.refresh(listOf(it)) } } }
    val box = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, t.border, RoundedCornerShape(10.dp)).padding(10.dp)
    when {
        ev == null -> Column(box) { label?.let { Dim(it, size = 12) }; Dim("…") }
        note == null -> Column(box) { Dim(s.t("post.quote.unavailable"), size = 13) }
        else -> Column(box, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            label?.let { Dim(it, size = 12) }
            val p = prof[note.pubkey]
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(note.pubkey, p?.name, p?.picture, 24.dp)
                Spacer(Modifier.width(8.dp))
                Text(p?.name ?: (note.pubkey.take(8) + "…"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
            val tokens = remember(note.id) { NoteTokens.parse(note.content, NoteTokens.imetaUrls(note.tags)) }
            val preview = tokens.joinToString("") { when (it) { is Token.Text -> it.value; is Token.Link -> it.url; else -> "" } }.trim().take(280)
            if (preview.isNotEmpty()) Text(preview, fontSize = 14.sp, lineHeight = 20.sp)
            if (allowImages) tokens.filterIsInstance<Token.Image>().map { it.url }.distinct().filter { it.startsWith("https://") }.take(2).forEach {
                AsyncImage(it, null, Modifier.fillMaxWidth().heightIn(max = 240.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.FillWidth)
            }
        }
    }
}
