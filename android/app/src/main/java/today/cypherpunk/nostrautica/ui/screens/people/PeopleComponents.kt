package today.cypherpunk.nostrautica.ui.screens.people

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.FollowListGuard
import today.cypherpunk.nostrautica.domain.people.Band
import today.cypherpunk.nostrautica.domain.people.peopleSocial
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.protocol.Match
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.DisplayFont
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.NumberFormat
import java.util.Locale

/**
 * Writes the user started (follow, want-to-meet, mute, a note) run here rather
 * than in the screen's scope, so leaving the screen mid-sign can't drop them.
 */
internal val PeopleWrites = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate)

// ── ConfidenceBadge.svelte ───────────────────────────────────────────────────

/**
 * The band as a pill: three distinct weights (vivid fill / dark fill / neutral
 * chip) and a glyph whose SHAPE also encodes it (rising curve / gentle arc /
 * dashed line), never colour alone. [section] picks the collective wording.
 */
@Composable
fun ConfidenceBadge(band: Band, small: Boolean = false, section: Boolean = false) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    val key = when (band) {
        Band.STRONG -> "matches.band.strong"
        Band.GOOD -> "matches.band.good"
        Band.HELLO -> "matches.band.hello"
    } + if (section) ".section" else ""
    val (bg, fg) = when (band) {
        Band.STRONG -> t.matchStrongBg to t.matchStrongFg
        Band.GOOD -> t.matchGoodBg to t.matchGoodFg
        Band.HELLO -> t.bgElev2 to t.textDim
    }
    Row(
        Modifier.clip(RoundedCornerShape(999.dp)).background(bg)
            .let { if (band == Band.HELLO) it.border(1.dp, t.border, RoundedCornerShape(999.dp)) else it }
            .padding(start = if (small) 7.dp else 9.dp, end = if (small) 9.dp else 11.dp, top = if (small) 3.dp else 5.dp, bottom = if (small) 3.dp else 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RouteGlyph(band, fg, if (small) 28.dp else 32.dp, if (small) 14.dp else 16.dp)
        Spacer(Modifier.width(6.dp))
        Text(s.t(key), color = fg, fontWeight = FontWeight.Bold, fontSize = if (small) 12.5.sp else 13.5.sp, maxLines = 1)
    }
}

@Composable
private fun RouteGlyph(band: Band, color: Color, w: Dp, h: Dp) {
    Canvas(Modifier.size(w, h)) {
        val sx = size.width / 30f
        val sy = size.height / 16f
        fun p(x: Float, y: Float) = Offset(x * sx, y * sy)
        val stroke = 1.8f * sx
        when (band) {
            Band.STRONG -> {
                val path = Path().apply { moveTo(3 * sx, 12 * sy); quadraticTo(11 * sx, 2 * sy, 27 * sx, 4 * sy) }
                drawPath(path, color, style = Stroke(stroke, cap = StrokeCap.Round))
                drawCircle(color, 2.4f * sx, p(3f, 12f)); drawCircle(color, 2.8f * sx, p(27f, 4f))
            }
            Band.GOOD -> {
                val path = Path().apply { moveTo(3 * sx, 11 * sy); quadraticTo(13 * sx, 6 * sy, 27 * sx, 7 * sy) }
                drawPath(path, color, style = Stroke(stroke, cap = StrokeCap.Round))
                drawCircle(color, 2.4f * sx, p(3f, 11f)); drawCircle(color, 2.6f * sx, p(27f, 7f))
            }
            Band.HELLO -> {
                drawLine(color, p(3f, 9f), p(27f, 9f), stroke, StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(1f * sx, 4f * sx)))
                drawCircle(color, 2.2f * sx, p(3f, 9f)); drawCircle(color, 2.2f * sx, p(27f, 9f))
            }
        }
    }
}

/** The solid "NEW" pill (the one roster chip treatment nothing else uses). */
@Composable
fun NewPill() {
    val t = LocalTokens.current
    Text(
        LocalStrings.current.t("matches.new").uppercase(),
        Modifier.clip(RoundedCornerShape(999.dp)).background(t.accentBg).padding(horizontal = 7.dp, vertical = 1.dp),
        color = t.accentContrast, fontSize = 10.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, maxLines = 1,
    )
}

@Composable
fun Chip(text: String, modifier: Modifier = Modifier, accent: Boolean = false) {
    val t = LocalTokens.current
    Text(
        text,
        modifier.clip(RoundedCornerShape(999.dp)).background(if (accent) t.accentSoft else t.bgElev2).padding(horizontal = 9.dp, vertical = 3.dp),
        color = if (accent) t.accent else t.text, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}

// ── Compact square action buttons (the roster's one action vocabulary) ──────

@Composable
fun SquareAction(icon: ImageVector, description: String, onClick: () -> Unit, pressed: Boolean = false, enabled: Boolean = true) {
    val t = LocalTokens.current
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(10.dp))
            .background(if (pressed) t.accentBg else Color.Transparent)
            .border(1.dp, if (pressed) t.accentBg else t.border, RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, Modifier.size(17.dp), tint = if (pressed) t.accentContrast else t.text) }
}

// ── FollowButton.svelte ──────────────────────────────────────────────────────

enum class FollowVariant { ICON, CTA }

/**
 * Follow / unfollow. ICON is the roster's dense skin (state in the pressed fill,
 * action named in the accessible label); CTA is the profile's button, which says
 * "Follow" at rest when not following. Signed-out taps go to sign-in.
 */
@Composable
fun FollowButton(pubkey: String, name: String, following: Boolean, onChange: (Boolean) -> Unit, variant: FollowVariant, modifier: Modifier = Modifier) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val account by c.session.account.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val hint = if (following) s.t("follow.unfollowName", "name" to name) else s.t("follow.followName", "name" to name)
    val toggle: () -> Unit = toggle@{
        if (busy) return@toggle
        if (account == null) { router.go(Route.Login()); return@toggle }
        val next = !following
        busy = true
        PeopleWrites.launch {
            runCatching { c.peopleSocial.setFollowing(pubkey, next) }
                .onSuccess { r ->
                    onChange(next)
                    if (r is Nostr.PublishResult.Queued) Toasts.show(s.t("sync.queued"))
                }
                .onFailure { e -> Toasts.show(if (e is FollowListGuard) s.t("error.followListGuard") else e.message ?: e.toString()) }
            busy = false
        }
    }
    when (variant) {
        FollowVariant.ICON -> SquareAction(if (following) Icons.Outlined.HowToReg else Icons.Outlined.PersonAddAlt, hint, toggle, pressed = following, enabled = !busy)
        FollowVariant.CTA -> {
            val label = if (busy) "…" else if (following) s.t("follow.followingCta") else s.t("follow.cta")
            val m = modifier.heightIn(min = 44.dp).semantics { contentDescription = hint }
            if (following) OutlinedButton(toggle, m, enabled = !busy, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, t.border)) {
                Text(label, fontWeight = FontWeight.SemiBold, color = t.text)
            } else Button(toggle, m, enabled = !busy, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = t.accentBg, contentColor = t.accentContrast)) {
                Text(label, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * Follow · want to meet · message: the same three controls for a matched person
 * and an unmatched one, in the same order (Attendees.svelte personActions).
 */
@Composable
fun PersonActions(
    pubkey: String,
    name: String,
    followsKnown: Boolean,
    following: Boolean,
    onFollowChange: (Boolean) -> Unit,
    wantToMeet: Boolean,
    onWantToMeet: () -> Unit,
    onMessage: () -> Unit,
) {
    val s = LocalStrings.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (followsKnown) FollowButton(pubkey, name, following, onFollowChange, FollowVariant.ICON)
        SquareAction(if (wantToMeet) Icons.Filled.Bookmark else Icons.Outlined.BookmarkBorder, s.t("attendees.wantToMeetName", "name" to name), onWantToMeet, pressed = wantToMeet)
        SquareAction(Icons.AutoMirrored.Outlined.Send, s.t("attendees.messageName", "name" to name), onMessage)
    }
}

// ── PersonCard.svelte ────────────────────────────────────────────────────────

/** A roster row: avatar, name (+ NEW), one line of who they are, quick actions. */
@Composable
fun PersonRow(
    pubkey: String,
    name: String,
    line: String?,
    picture: String?,
    isNew: Boolean,
    flash: Boolean,
    onOpen: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
    actions: (@Composable () -> Unit)? = null,
) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (flash) t.accentSoft else Color.Transparent),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f).clickable(onClick = onOpen).padding(vertical = 10.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(pubkey, name, picture, 40.dp)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f, fill = false), fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (isNew) { Spacer(Modifier.width(6.dp)); NewPill() }
                }
                if (line != null || trailing != null) Row(verticalAlignment = Alignment.CenterVertically) {
                    if (trailing != null) { trailing(); Spacer(Modifier.width(6.dp)) }
                    if (line != null) Dim(line, Modifier.weight(1f), maxLines = 1, size = 13)
                }
            }
        }
        if (actions != null) { Spacer(Modifier.width(4.dp)); actions() }
    }
}

// ── MatchEntry.svelte ────────────────────────────────────────────────────────

/**
 * One matched person in People. The reasoning is the product: always shown in
 * full, never clamped or collapsed, in the reading serif. Only the conversation
 * starters fold away. The whole entry opens the person; the reasoning stays
 * selectable so it can be quoted into a message.
 */
@Composable
fun MatchEntry(match: Match, name: String, sub: String?, picture: String?, isNew: Boolean, flash: Boolean, onOpen: () -> Unit, actions: @Composable () -> Unit) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    val icebreakers = remember(match) { (match.icebreakers ?: emptyList()).distinct() }
    var open by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (flash) t.accentSoft else Color.Transparent)
            .clickable(onClick = onOpen).padding(vertical = 12.dp, horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(match.pubkey, name, picture, 38.dp)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f, fill = false), fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (isNew) { Spacer(Modifier.width(6.dp)); NewPill() }
                }
                if (!sub.isNullOrBlank()) Dim(sub, maxLines = 1, size = 13)
            }
        }
        SelectionContainer {
            Text(match.reasoning, fontFamily = DisplayFont, fontSize = 16.5.sp, lineHeight = 24.sp)
        }
        if (icebreakers.isNotEmpty()) {
            Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable { open = !open }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(16.dp), tint = t.textDim)
                Spacer(Modifier.width(4.dp))
                Text(s.t("matches.icebreakers"), color = t.textDim, fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
            }
            if (open) Icebreakers(icebreakers)
        }
        actions()
    }
}

@Composable
private fun Icebreakers(items: List<String>) {
    val t = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.forEach { ib ->
            Row {
                Box(Modifier.padding(top = 9.dp).size(5.dp).clip(RoundedCornerShape(3.dp)).background(t.accent))
                Spacer(Modifier.width(9.dp))
                SelectionContainer { Text(ib, fontSize = 15.sp, lineHeight = 22.sp) }
            }
        }
    }
}

// ── MatchDetails.svelte ──────────────────────────────────────────────────────

private fun pct(v: Double, locale: String): String {
    val clamped = (if (v.isFinite()) v else 0.0).coerceIn(0.0, 1.0)
    return NumberFormat.getPercentInstance(Locale.forLanguageTag(locale)).apply { maximumFractionDigits = 0 }.format(clamped)
}

/** A single match out of list context: band pill, full reasoning, starters, actions, score breakdown. */
@Composable
fun MatchDetails(match: Match, band: Band, actions: @Composable () -> Unit) {
    val t = LocalTokens.current
    val s = LocalStrings.current
    var scores by remember { mutableStateOf(false) }
    val icebreakers = remember(match) { (match.icebreakers ?: emptyList()).distinct() }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ConfidenceBadge(band)
        SelectionContainer { Text(match.reasoning, fontFamily = DisplayFont, fontSize = 17.sp, lineHeight = 25.sp) }
        if (icebreakers.isNotEmpty()) {
            Text(s.t("matches.icebreakers"), color = t.textDim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Icebreakers(icebreakers)
        }
        actions()
        Column(Modifier.fillMaxWidth()) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(t.border))
            Row(Modifier.fillMaxWidth().clickable { scores = !scores }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(s.t("matches.scoreDetails"), Modifier.weight(1f), color = t.textDim, fontSize = 13.5.sp)
                Icon(if (scores) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(16.dp), tint = t.textDim)
            }
            if (scores) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((k, v) in listOf("matches.dim.similarity" to match.similarity, "matches.dim.complementarity" to match.complementarity, "matches.dim.overall" to match.score)) {
                    Row { Dim(s.t(k), Modifier.weight(1f)); Text(pct(v, s.locale), fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

// ── Loading skeleton (never a bare interactive shell while data is in flight) ─

@Composable
fun SkeletonCard() {
    val t = LocalTokens.current
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(56.dp).clip(RoundedCornerShape(28.dp)).background(t.bgElev2))
            Spacer(Modifier.width(12.dp))
            Box(Modifier.width(160.dp).height(16.dp).clip(RoundedCornerShape(6.dp)).background(t.bgElev2))
        }
        Box(Modifier.fillMaxWidth(0.85f).height(12.dp).clip(RoundedCornerShape(6.dp)).background(t.bgElev2))
        Box(Modifier.fillMaxWidth(0.6f).height(12.dp).clip(RoundedCornerShape(6.dp)).background(t.bgElev2))
    }
}

/** Wrapping row of chips. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipFlow(items: List<String>, accent: Boolean = false) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.distinct().forEach { Chip(it, accent = accent) }
    }
}

/** Small padding helper for inline text-like buttons. */
val InlineButtonPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
