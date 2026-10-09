package today.cypherpunk.nostrautica.ui.screens.content

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import today.cypherpunk.nostrautica.domain.content.Markdown
import today.cypherpunk.nostrautica.domain.content.Markdown.Block
import today.cypherpunk.nostrautica.domain.content.Markdown.Inline
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * Open a link from content someone else wrote: https in the browser, `nostr:`
 * in whatever Nostr app is installed (njump.me when there is none).
 */
fun openExternal(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        if (url.startsWith("nostr:")) runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://njump.me/" + url.removePrefix("nostr:"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    } catch (_: Exception) {
    }
}

/**
 * Renders [Markdown] natively. Images load only over https and only when the
 * reader allows off-origin images (Settings → Privacy); otherwise the address
 * shows as a link, so nothing is silently dropped. [onLink] may claim a link
 * (an internal post) before it is opened externally.
 */
@Composable
fun MarkdownView(source: String, modifier: Modifier = Modifier, onLink: (String) -> Boolean = { false }) {
    val blocks = remember(source) { Markdown.parse(source) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { MdBlock(it, onLink) }
    }
}

@Composable
private fun MdBlock(b: Block, onLink: (String) -> Boolean) {
    val t = LocalTokens.current
    when (b) {
        is Block.Heading -> MdInlines(b.content, onLink, size = when (b.level) { 1 -> 20; 2 -> 18; else -> 16 }, weight = FontWeight.SemiBold)
        is Block.Paragraph -> MdInlines(b.content, onLink)
        is Block.Code -> Box(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(t.bgElev2).horizontalScroll(rememberScrollState()).padding(10.dp),
        ) { Text(b.text, fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 18.sp) }
        is Block.Quote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(t.accent.copy(alpha = 0.6f)))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { b.blocks.forEach { MdBlock(it, onLink) } }
        }
        is Block.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            b.items.forEach { item ->
                Row(Modifier.padding(start = (item.depth * 18).dp)) {
                    Text(if (item.ordered) "${item.number}." else "•", Modifier.widthIn(min = 18.dp), color = t.textDim)
                    Spacer(Modifier.width(6.dp))
                    Column(Modifier.weight(1f)) { MdInlines(item.content, onLink) }
                }
            }
        }
        is Block.Table -> Column(
            Modifier.horizontalScroll(rememberScrollState()).border(1.dp, t.border, RoundedCornerShape(6.dp)),
        ) {
            (listOf(b.header) + b.rows).forEachIndexed { i, row ->
                Row {
                    row.forEach { cell ->
                        Box(Modifier.widthIn(min = 80.dp, max = 240.dp).border(0.5.dp, t.border).padding(horizontal = 8.dp, vertical = 4.dp)) {
                            MdInlines(cell, onLink, weight = if (i == 0) FontWeight.SemiBold else null)
                        }
                    }
                }
            }
        }
    }
}

/** A run of inlines: text spans as one Text, images as their own blocks in between. */
@Composable
private fun MdInlines(list: List<Inline>, onLink: (String) -> Boolean, size: Int = 16, weight: FontWeight? = null) {
    val t = LocalTokens.current
    val context = LocalContext.current
    val allowImages by LocalContainer.current.prefs.externalImages.collectAsState()
    val linkStyle = TextLinkStyles(SpanStyle(color = t.accent, textDecoration = TextDecoration.Underline))
    val runs = remember(list) {
        val out = mutableListOf<Any>() // List<Inline.Text> | Inline.Image
        var cur = mutableListOf<Inline.Text>()
        for (i in list) when (i) {
            is Inline.Text -> cur += i
            is Inline.Image -> { if (cur.isNotEmpty()) { out.add(cur); cur = mutableListOf() }; out.add(i) }
        }
        if (cur.isNotEmpty()) out.add(cur)
        out
    }
    fun click(url: String) { if (!onLink(url)) openExternal(context, url) }
    for (run in runs) {
        if (run is Inline.Image) {
            if (allowImages && run.url.startsWith("https://")) {
                AsyncImage(
                    model = run.url, contentDescription = run.alt.ifEmpty { null }, contentScale = ContentScale.FillWidth,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)),
                )
            } else {
                Text(
                    buildAnnotatedString { withLink(LinkAnnotation.Clickable(run.url, linkStyle) { click(run.url) }) { append(run.url) } },
                    fontSize = 13.sp, color = t.textDim,
                )
            }
            continue
        }
        @Suppress("UNCHECKED_CAST") val spans = run as List<Inline.Text>
        val text: AnnotatedString = buildAnnotatedString {
            for (sp in spans) {
                val style = SpanStyle(
                    fontWeight = if (sp.bold) FontWeight.Bold else weight,
                    fontStyle = if (sp.italic) FontStyle.Italic else null,
                    fontFamily = if (sp.code) FontFamily.Monospace else null,
                    background = if (sp.code) t.bgElev2 else androidx.compose.ui.graphics.Color.Unspecified,
                )
                val link = sp.link
                if (link != null) withLink(LinkAnnotation.Clickable(link, linkStyle) { click(link) }) { withStyle(style) { append(sp.text) } }
                else withStyle(style) { append(sp.text) }
            }
        }
        Text(text, style = MaterialTheme.typography.bodyLarge.copy(fontSize = size.sp, lineHeight = (size * 1.5).sp))
    }
}
