package today.cypherpunk.nostrautica.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.theme.DisplayFont
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

// ── Colour derivations (identity/avatar.ts, theme-injector.ts) ──────────────

/** avatarHues: two hues from sha256(seed), as the PWA computes them. */
fun avatarHues(seed: String): Pair<Float, Float> {
    val h = Bytes.sha256Hex(Bytes.utf8(seed.ifEmpty { "anon" }))
    val h1 = h.substring(0, 2).toInt(16) * 360f / 255f
    val h2 = (h1 + 40 + h.substring(2, 4).toInt(16) % 80) % 360
    return h1 to h2
}

fun hsl(h: Float, s: Float, l: Float, a: Float = 1f): Color = Color.hsl(h, s, l, a)

/** initialsFor: first letters of the first and last word, else two letters. */
fun initialsFor(name: String?, npub: String? = null): String {
    val t = name?.trim().orEmpty()
    if (t.isNotEmpty()) {
        val words = t.split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.size >= 2) return (firstGrapheme(words.first()) + firstGrapheme(words.last())).uppercase()
        return words[0].codePoints().limit(2).toArray().joinToString("") { String(Character.toChars(it)) }.uppercase()
    }
    val body = npub?.removePrefix("npub1").orEmpty()
    return if (body.isNotEmpty()) body.take(2).uppercase() else "?"
}

private fun firstGrapheme(s: String) = s.codePoints().limit(1).toArray().joinToString("") { String(Character.toChars(it)) }

// ── Surfaces ────────────────────────────────────────────────────────────────

@Composable
fun Card(modifier: Modifier = Modifier, padding: Dp = 18.dp, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val t = LocalTokens.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(t.bgElev)
            .border(1.dp, t.cardBorder, RoundedCornerShape(14.dp))
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(padding),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
fun SoftCard(modifier: Modifier = Modifier, color: Color, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(color).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = DisplayFont, fontSize = 30.sp))
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold))
        trailing?.invoke()
    }
}

@Composable
fun Dim(text: String, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE, size: Int = 14) {
    Text(text, modifier, color = LocalTokens.current.textDim, fontSize = size.sp, lineHeight = (size * 1.45).sp, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

@Composable
fun Body(text: String, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE, serif: Boolean = false) {
    Text(
        text, modifier, maxLines = maxLines, overflow = TextOverflow.Ellipsis,
        style = if (serif) MaterialTheme.typography.bodyLarge.copy(fontFamily = DisplayFont, fontSize = 18.sp, lineHeight = 26.sp) else MaterialTheme.typography.bodyLarge,
    )
}

@Composable
fun Divider() = HorizontalDivider(color = LocalTokens.current.border)

// ── Buttons ─────────────────────────────────────────────────────────────────

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, busy: Boolean = false, icon: ImageVector? = null) {
    val t = LocalTokens.current
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp),
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(containerColor = t.accentBg, contentColor = t.accentContrast),
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = t.accentContrast, strokeWidth = 2.dp)
        else {
            if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
            Text(text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        }
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, busy: Boolean = false, icon: ImageVector? = null, danger: Boolean = false) {
    val t = LocalTokens.current
    OutlinedButton(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp),
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, if (danger) t.danger.copy(alpha = 0.5f) else t.border),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = if (danger) t.danger else t.text),
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else {
            if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
            Text(text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        }
    }
}

@Composable
fun SmallButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, selected: Boolean = false, enabled: Boolean = true) {
    val t = LocalTokens.current
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 40.dp),
        shape = RoundedCornerShape(10.dp),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
        border = BorderStroke(1.dp, if (selected) t.accent else t.border),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = if (selected) t.accentSoft else Color.Transparent, contentColor = if (selected) t.accent else t.text),
    ) {
        if (icon != null) { Icon(icon, null, Modifier.size(16.dp)); if (text.isNotEmpty()) Spacer(Modifier.width(6.dp)) }
        if (text.isNotEmpty()) Text(text, fontWeight = FontWeight.Medium, fontSize = 14.sp)
    }
}

@Composable
fun LinkButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(onClick = onClick, modifier = modifier) { Text(text, color = LocalTokens.current.accent, fontWeight = FontWeight.Medium) }
}

/** The "‹ All events" pill the PWA puts top-left. */
@Composable
fun BackPill(text: String, onClick: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, t.border, RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, null, Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun IconSquare(icon: ImageVector, contentDescription: String?, onClick: () -> Unit, modifier: Modifier = Modifier, highlighted: Boolean = false) {
    val t = LocalTokens.current
    Box(
        modifier.size(40.dp).clip(RoundedCornerShape(10.dp))
            .background(if (highlighted) t.accentBg else Color.Transparent)
            .border(1.dp, if (highlighted) t.accentBg else t.border, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription, Modifier.size(18.dp), tint = if (highlighted) t.accentContrast else t.text) }
}

// ── Pills, badges ───────────────────────────────────────────────────────────

@Composable
fun Pill(text: String, bg: Color, fg: Color, modifier: Modifier = Modifier) {
    Text(
        text, modifier.clip(RoundedCornerShape(999.dp)).background(bg).padding(horizontal = 10.dp, vertical = 3.dp),
        color = fg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
    )
}

@Composable
fun NewBadge(text: String) = Text(text.uppercase(), color = LocalTokens.current.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)

// ── Avatars ─────────────────────────────────────────────────────────────────

@Composable
fun Avatar(pubkey: String, name: String?, picture: String?, size: Dp = 44.dp, modifier: Modifier = Modifier) {
    val prefs = LocalContainer.current.prefs
    val allowExternal by prefs.externalImages.collectAsState()
    val (h1, h2) = avatarHues(pubkey)
    Box(
        modifier.size(size).clip(CircleShape)
            .background(Brush.linearGradient(listOf(hsl(h1, 0.55f, 0.29f), hsl(h2, 0.50f, 0.24f)))),
        contentAlignment = Alignment.Center,
    ) {
        Text(initialsFor(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.36f).sp)
        if (picture != null && allowExternal) {
            AsyncImage(model = picture, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(CircleShape))
        }
    }
}

// ── The event header (EventHeader.svelte) ───────────────────────────────────

@Composable
fun EventWash(coordinate: String?, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val t = LocalTokens.current
    val (h1, h2) = coordinate?.let { Coordinate.parseOrNull(it)?.pubkey }?.let(::avatarHues) ?: (256f to 322f)
    val brush = if (t.dark) Brush.linearGradient(listOf(hsl(h1, .72f, .62f, .22f), hsl(h2, .65f, .58f, .12f), Color.Transparent))
    else Brush.linearGradient(listOf(hsl(h1, .70f, .55f, .14f), hsl(h2, .62f, .55f, .08f), Color.Transparent))
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(t.bgElev).background(brush)
            .border(1.dp, t.cardBorder, RoundedCornerShape(14.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

// ── States ──────────────────────────────────────────────────────────────────

@Composable
fun Loading(text: String? = null, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        if (text != null) { Spacer(Modifier.width(12.dp)); Dim(text) }
    }
}

@Composable
fun EmptyState(title: String, body: String? = null, action: (@Composable () -> Unit)? = null) {
    Card {
        Text(title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        if (body != null) Dim(body)
        action?.invoke()
    }
}

@Composable
fun ErrorCard(text: String, onRetry: (() -> Unit)? = null, retryLabel: String = "Retry") {
    val t = LocalTokens.current
    SoftCard(color = t.dangerSoft) {
        Text(text, color = t.text)
        if (onRetry != null) SmallButton(retryLabel, onRetry)
    }
}

@Composable
fun Notice(text: String, color: Color = LocalTokens.current.accentSoft, action: (@Composable RowScope.() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(color).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), fontSize = 14.sp, lineHeight = 20.sp)
        action?.invoke(this)
    }
}

@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    supporting: String? = null,
    isError: Boolean = false,
    enabled: Boolean = true,
    keyboard: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default,
    visual: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
) {
    val t = LocalTokens.current
    OutlinedTextField(
        value = value, onValueChange = onChange, modifier = modifier.fillMaxWidth(),
        label = { Text(label) }, placeholder = placeholder?.let { { Text(it, color = t.textDim) } },
        singleLine = singleLine, minLines = minLines, isError = isError, enabled = enabled,
        supportingText = supporting?.let { { Text(it) } }, keyboardOptions = keyboard, visualTransformation = visual,
        shape = RoundedCornerShape(10.dp),
        colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = t.border, focusedBorderColor = t.accent, unfocusedContainerColor = t.bgElev, focusedContainerColor = t.bgElev),
    )
}

@Composable
fun Gap(h: Dp = 12.dp) = Spacer(Modifier.height(h))
