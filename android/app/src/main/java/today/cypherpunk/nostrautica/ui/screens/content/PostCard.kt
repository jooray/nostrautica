package today.cypherpunk.nostrautica.ui.screens.content

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import today.cypherpunk.nostrautica.domain.content.EventPost
import today.cypherpunk.nostrautica.domain.content.PageLogic
import today.cypherpunk.nostrautica.domain.content.PostSource
import today.cypherpunk.nostrautica.domain.content.ResolvedTarget
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

fun shortDay(sec: Long, locale: String): String =
    DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(locale)).format(Date(sec * 1000))

/**
 * Markdown links inside an event's posts: a `nostr:naddr` of one of this event's
 * own posts opens in the app; everything else goes out.
 */
fun internalPostLink(naddr: String, go: (Route) -> Unit): (String) -> Boolean = { url ->
    val eid = runCatching { Coordinate.fromNaddr(naddr).first.pubkey }.getOrNull()
    when (val r = eid?.let { PageLogic.resolveTarget(it, url) }) {
        is ResolvedTarget.Post -> { go(Route.Post(naddr, r.d)); true }
        else -> false
    }
}

/**
 * One post in a feed (PostCard.svelte). A members-only post the reader can't
 * decrypt shows a lock and a join prompt — a non-member learns only that it exists.
 */
@Composable
fun PostCard(post: EventPost, naddr: String, full: Boolean = false, openable: Boolean = true) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val allowImages by LocalContainer.current.prefs.externalImages.collectAsState()
    fun open() = router.go(Route.Post(naddr, post.d))
    Card {
        if (post.locked) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Lock, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(s.t("post.locked.title"), Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                Pill(s.t("post.membersBadge"), t.accentSoft, t.accent)
            }
            Dim(if (post.newer) s.t("update.available") else s.t("post.locked.body"))
            if (!post.newer) PrimaryButton(s.t("post.locked.join"), { router.go(Route.Join(naddr)) })
            return@Card
        }
        Row(verticalAlignment = Alignment.Top) {
            Text(
                post.title,
                Modifier.weight(1f).let { if (openable) it.clickable(onClick = ::open) else it },
                fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp,
                textDecoration = if (openable) TextDecoration.Underline else null,
            )
            Spacer(Modifier.width(8.dp))
            Dim(shortDay(post.publishedAt, s.locale) + if (post.editedAt > post.publishedAt) " " + s.t("post.edited") else "", size = 12)
        }
        val badges = buildList {
            if (post.membersOnly) add(s.t("post.membersBadge"))
            if (post.source == PostSource.ATTENDEES) add(s.t("post.attendeeBadge"))
            if (post.source == PostSource.EXTERNAL) {
                // Curated in from another npub (31608 `sources`): say so, or it reads as the event's own.
                val name = post.feedLabel?.trim()?.takeIf { it.isNotEmpty() } ?: (Nip19.npub(post.authorPubkey).take(12) + "…")
                add(s.t("post.fromFeed", "name" to name))
            }
        }
        if (badges.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            badges.forEach { Pill(it, t.bgElev2, t.textDim) }
        }
        if (full) {
            val img = post.image
            if (img != null && allowImages && img.startsWith("https://")) {
                AsyncImage(img, null, Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.FillWidth)
            }
            MarkdownView(post.content, onLink = internalPostLink(naddr, router::go))
            if (openable) SmallButton(s.t("post.open"), ::open)
        } else {
            post.summary?.takeIf { it.isNotBlank() }?.let { Dim(it) }
            LinkButton(s.t("post.read"), ::open)
        }
    }
}
