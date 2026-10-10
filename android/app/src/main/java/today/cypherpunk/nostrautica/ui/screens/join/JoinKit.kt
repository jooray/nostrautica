package today.cypherpunk.nostrautica.ui.screens.join

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import today.cypherpunk.nostrautica.domain.join.introMedia
import today.cypherpunk.nostrautica.domain.media.UserFacingError
import today.cypherpunk.nostrautica.i18n.I18n
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Media
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** A thrown error as a sentence: catalog keys are translated, anything else shown as-is. */
fun errorText(e: Throwable, s: I18n.Strings): String = when (e) {
    is UserFacingError -> s.t(e.key, *e.params.map { it.key to it.value }.toTypedArray())
    else -> e.message?.takeIf { it.isNotBlank() }?.let { m -> if (s.has(m)) s.t(m) else m } ?: s.t("error.state.retry")
}

/** "14:32" in the viewer's locale. */
fun clockTime(ms: Long, locale: String): String = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.forLanguageTag(locale)).format(Date(ms))

@Composable
fun CheckRow(checked: Boolean, onChange: (Boolean) -> Unit, text: String, sub: String? = null, isError: Boolean = false) {
    val t = LocalTokens.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { onChange(!checked) }, verticalAlignment = Alignment.Top) {
        Checkbox(checked, onChange)
        Column(Modifier.weight(1f).padding(top = 12.dp)) {
            Text(text, fontSize = 15.sp, color = if (isError) t.danger else t.text)
            if (sub != null) Dim(sub, size = 13)
        }
    }
}

@Composable
fun RadioRow(selected: Boolean, onSelect: () -> Unit, text: String, sub: String? = null) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onSelect), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, onSelect)
        Column(Modifier.weight(1f)) {
            Text(text, fontSize = 15.sp)
            if (sub != null) Dim(sub, size = 13)
        }
    }
}

/** Pressed-toggle group (Record's mode / talk-source switchers). */
@Composable
fun ToggleGroup(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((id, label) in options) SmallButton(label, { onSelect(id) }, selected = id == selected)
    }
}

/** A thin determinate bar with "sent / total". */
@Composable
fun ProgressLine(fraction: Float, label: String?) {
    val t = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(t.bgElev2)) {
            Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().background(t.accent))
        }
        if (label != null) Dim(label, size = 12)
    }
}

fun formatBytes(n: Long): String = when {
    n >= 1024L * 1024 -> String.format(Locale.ROOT, "%.1f MB", n / (1024.0 * 1024))
    n >= 1024 -> String.format(Locale.ROOT, "%.0f kB", n / 1024.0)
    else -> "$n B"
}

/** Plays a local file (a fresh take, or a decrypted clip) with the system media controls. */
@Composable
fun FilePlayer(file: File, audio: Boolean) {
    val ctx = LocalContext.current
    val player = remember(file) {
        ExoPlayer.Builder(ctx).build().apply { setMediaItem(MediaItem.fromUri(Uri.fromFile(file))); prepare() }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView(
        factory = { PlayerView(it).apply { this.player = player; controllerShowTimeoutMs = 0; controllerHideOnTouch = false } },
        modifier = Modifier.fillMaxWidth().height(if (audio) 96.dp else 260.dp).clip(RoundedCornerShape(12.dp)),
    )
}

/**
 * An encrypted library clip, on demand: download → verify → decrypt → play
 * (MediaPlayer.svelte). The plaintext lives in the app cache, named by its hash,
 * so a second preview costs nothing.
 */
@Composable
fun EncryptedClip(d: MediaDescriptor) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var file by remember(d.x) { mutableStateOf<File?>(null) }
    var status by remember(d.x) { mutableStateOf<String?>(null) }
    var error by remember(d.x) { mutableStateOf<String?>(null) }
    val f = file
    if (f != null) { FilePlayer(f, d.isAudio); return }
    error?.let { Dim(s.t("media.playError", "reason" to it), size = 13) }
    if (status != null) Dim(status!!, size = 13)
    else SmallButton(if (d.isAudio) s.t("media.playAudio") else s.t("media.playIntro"), {
        error = null
        status = s.t("media.connecting")
        scope.launch {
            runCatching {
                val dir = File(ctx.cacheDir, "media").apply { mkdirs() }
                val out = File(dir, d.ox)
                if (!out.exists()) {
                    val ct = c.introMedia.blossom.download(d.url, d.x, d.size) { p ->
                        status = if (p.total != null) s.t("media.downloadingOf", "done" to formatBytes(p.received), "total" to formatBytes(p.total)) else s.t("media.downloading", "done" to formatBytes(p.received))
                    }
                    status = s.t("media.decrypting")
                    val pt = withContext(Dispatchers.Default) { Media.decrypt(d, ct) }
                    withContext(Dispatchers.IO) { out.writeBytes(pt) }
                }
                out
            }.onSuccess { file = it; status = null }.onFailure { error = it.message ?: "?"; status = null }
        }
    })
}
