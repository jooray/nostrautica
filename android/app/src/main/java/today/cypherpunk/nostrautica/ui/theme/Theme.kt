package today.cypherpunk.nostrautica.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The PWA's design tokens (packages/app/src/lib/styles/app.css), dark and light.
 * Material's slots are filled from them so stock components look like the web app.
 */
@Immutable
data class Tokens(
    val bg: Color,
    val bgElev: Color,
    val bgElev2: Color,
    val bgRaised: Color,
    val text: Color,
    val textDim: Color,
    val border: Color,
    val cardBorder: Color,
    val accent: Color,
    val accentBg: Color,
    val accentSoft: Color,
    val accentContrast: Color,
    val ok: Color,
    val warn: Color,
    val danger: Color,
    val okSoft: Color,
    val warnSoft: Color,
    val dangerSoft: Color,
    val matchStrongBg: Color,
    val matchStrongFg: Color,
    val matchGoodBg: Color,
    val matchGoodFg: Color,
    val dark: Boolean,
)

val DarkTokens = Tokens(
    bg = Color(0xFF0E0E15), bgElev = Color(0xFF17171F), bgElev2 = Color(0xFF22222E), bgRaised = Color(0xFF1D1D27),
    text = Color(0xFFEDEDF4), textDim = Color(0xFFA2A2BA), border = Color(0xFF272734), cardBorder = Color(0xFF23232F),
    accent = Color(0xFFA18AFF), accentBg = Color(0xFF7C5CFF), accentSoft = Color(0x298C6EFF), accentContrast = Color.White,
    ok = Color(0xFF3FB877), warn = Color(0xFFE0A53A), danger = Color(0xFFE5686C),
    okSoft = Color(0x293FB877), warnSoft = Color(0x29E0A53A), dangerSoft = Color(0x24E5686C),
    matchStrongBg = Color(0xFF1DB954), matchStrongFg = Color(0xFF072B16), matchGoodBg = Color(0xFF15803D), matchGoodFg = Color.White,
    dark = true,
)

val LightTokens = Tokens(
    bg = Color(0xFFFAFAFC), bgElev = Color.White, bgElev2 = Color(0xFFF2F1F7), bgRaised = Color.White,
    text = Color(0xFF17171F), textDim = Color(0xFF5C5B70), border = Color(0xFFE6E5EF), cardBorder = Color(0xFFECECF3),
    accent = Color(0xFF6544E6), accentBg = Color(0xFF6C4CF2), accentSoft = Color(0x1A6C4CF2), accentContrast = Color.White,
    ok = Color(0xFF1E7F4F), warn = Color(0xFF8A5C04), danger = Color(0xFFC62B31),
    okSoft = Color(0x242F9E63), warnSoft = Color(0x26CF8A1A), dangerSoft = Color(0x1AD83A3F),
    matchStrongBg = Color(0xFF1DB954), matchStrongFg = Color(0xFF072B16), matchGoodBg = Color(0xFF15803D), matchGoodFg = Color.White,
    dark = false,
)

val LocalTokens = staticCompositionLocalOf { DarkTokens }

/** The serif display face the PWA uses for headings (Iowan/Palatino stack). */
val DisplayFont = FontFamily.Serif

@Composable
fun NostrauticaTheme(themePref: String = "system", content: @Composable () -> Unit) {
    val dark = when (themePref) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val t = if (dark) DarkTokens else LightTokens
    val scheme = if (dark) {
        darkColorScheme(
            primary = t.accentBg, onPrimary = t.accentContrast, primaryContainer = t.accentSoft, onPrimaryContainer = t.text,
            secondary = t.accent, onSecondary = t.accentContrast,
            background = t.bg, onBackground = t.text, surface = t.bgElev, onSurface = t.text,
            surfaceVariant = t.bgElev2, onSurfaceVariant = t.textDim, surfaceContainer = t.bgElev,
            surfaceContainerHigh = t.bgElev2, surfaceContainerLow = t.bgElev, surfaceContainerLowest = t.bg,
            surfaceContainerHighest = t.bgElev2, outline = t.border, outlineVariant = t.cardBorder,
            error = t.danger, onError = Color.White, errorContainer = t.dangerSoft, onErrorContainer = t.text,
        )
    } else {
        lightColorScheme(
            primary = t.accentBg, onPrimary = t.accentContrast, primaryContainer = t.accentSoft, onPrimaryContainer = t.text,
            secondary = t.accent, onSecondary = t.accentContrast,
            background = t.bg, onBackground = t.text, surface = t.bgElev, onSurface = t.text,
            surfaceVariant = t.bgElev2, onSurfaceVariant = t.textDim, surfaceContainer = t.bgElev,
            surfaceContainerHigh = t.bgElev2, surfaceContainerLow = t.bgElev, surfaceContainerLowest = t.bg,
            surfaceContainerHighest = t.bgElev2, outline = t.border, outlineVariant = t.cardBorder,
            error = t.danger, onError = Color.White, errorContainer = t.dangerSoft, onErrorContainer = t.text,
        )
    }
    val base = Typography()
    val type = base.copy(
        headlineLarge = base.headlineLarge.copy(fontFamily = DisplayFont, fontWeight = FontWeight.SemiBold),
        headlineMedium = base.headlineMedium.copy(fontFamily = DisplayFont, fontWeight = FontWeight.SemiBold),
        headlineSmall = base.headlineSmall.copy(fontFamily = DisplayFont, fontWeight = FontWeight.SemiBold),
        titleLarge = base.titleLarge.copy(fontFamily = DisplayFont, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    )
    val shapes = Shapes(
        small = RoundedCornerShape(10.dp),
        medium = RoundedCornerShape(14.dp),
        large = RoundedCornerShape(14.dp),
    )
    CompositionLocalProvider(LocalTokens provides t) {
        MaterialTheme(colorScheme = scheme, typography = type, shapes = shapes, content = content)
    }
}
