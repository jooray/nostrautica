package today.cypherpunk.nostrautica.ui.screens.content

import android.net.Uri
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import today.cypherpunk.nostrautica.domain.content.ExternalVideo
import today.cypherpunk.nostrautica.domain.content.content
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * A talk hosted outside Blossom (ExternalTalkPlayer.svelte). Nothing contacts
 * the third-party host until the viewer agrees, having been shown which host
 * that is. YouTube then opens in the YouTube app (or browser); a direct video
 * file plays in ExoPlayer with the shared speed control.
 */
@Composable
fun ExternalTalkPlayer(url: String, kind: String) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    var loaded by remember(url) { mutableStateOf(false) }
    val youTubeId = remember(url) { if (kind == "youtube") ExternalVideo.youTubeId(url) else null }
    val direct = remember(url) { if (kind == "youtube") null else ExternalVideo.directUrl(url) }
    val open = { openExternal(ctx, if (youTubeId != null) ExternalVideo.youTubeWatchUrl(youTubeId) else url) }

    if (!loaded || direct == null) {
        SoftCard(color = t.bgElev2) {
            Text(s.t("talks.external.gate.title"), fontWeight = FontWeight.SemiBold)
            Dim(s.t("talks.external.gate.host") + " " + (ExternalVideo.host(url) ?: url))
            Dim(s.t("talks.external.gate.note"), size = 13)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (direct != null) SmallButton(s.t("talks.external.gate.load"), { loaded = true }, selected = true)
                else if (youTubeId != null) SmallButton(s.t("talks.external.gate.load"), open, selected = true)
                SmallButton(s.t("talks.external.open"), open)
            }
        }
        return
    }
    DirectVideo(direct)
}

@OptIn(UnstableApi::class)
@Composable
private fun DirectVideo(url: String) {
    val ctx = LocalContext.current
    val content = LocalContainer.current.content
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var rate by remember { mutableFloatStateOf(content.playbackRate()) }
    val player = remember(url) {
        ExoPlayer.Builder(ctx).build().apply {
            setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            setPlaybackSpeed(rate)
            prepare()
        }
    }
    DisposableEffect(player) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) player.pause() }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); player.release() }
    }
    AndroidView(
        factory = { c ->
            PlayerView(c).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                this.player = player
            }
        },
        modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Color.Black),
    )
    SpeedRow(rate) { r -> rate = r; player.setPlaybackSpeed(r); content.setPlaybackRate(r) }
}
