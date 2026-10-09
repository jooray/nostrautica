package today.cypherpunk.nostrautica.ui.screens.content

import android.net.Uri
import android.text.format.Formatter
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import today.cypherpunk.nostrautica.domain.content.Content
import today.cypherpunk.nostrautica.domain.content.MediaFiles
import today.cypherpunk.nostrautica.domain.content.Vtt
import today.cypherpunk.nostrautica.domain.content.content
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.MediaTranscript
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.io.File

private sealed interface LoadState {
    data object Idle : LoadState
    data class Loading(val p: MediaFiles.Progress?) : LoadState
    data class Ready(val file: File) : LoadState
    data class Failed(val reason: String) : LoadState
}

/**
 * Encrypted Blossom media (MediaPlayer.svelte). Nothing is fetched until the
 * viewer presses play; then the whole ciphertext downloads (progress shown —
 * AES-GCM is whole-file, so it can't stream), is verified and decrypted to a
 * temp file, and plays in ExoPlayer with the transcript as optional captions,
 * a persisted speed choice and the resume position. Leaving the screen stops
 * the download or player and deletes the decrypted file.
 */
@Composable
fun EncryptedMediaPlayer(
    descriptor: MediaDescriptor,
    transcript: MediaTranscript?,
    resumeAt: Long = 0,
    onProgress: ((Long) -> Unit)? = null,
) {
    val c = LocalContainer.current
    val content = c.content
    val s = LocalStrings.current
    var state by remember(descriptor.x) { mutableStateOf<LoadState>(LoadState.Idle) }
    var attempt by remember(descriptor.x) { mutableIntStateOf(0) }
    var held by remember(descriptor.x) { mutableStateOf<String?>(null) }

    LaunchedEffect(descriptor.x, attempt) {
        if (attempt == 0) return@LaunchedEffect
        state = LoadState.Loading(null)
        state = try {
            val f = content.media.acquire(descriptor) { p -> state = LoadState.Loading(p) }
            held = descriptor.x
            LoadState.Ready(f)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LoadState.Failed(e.message ?: e.javaClass.simpleName)
        }
    }
    DisposableEffect(descriptor.x) { onDispose { held?.let { content.media.release(it) } } }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val st = state) {
            LoadState.Idle -> SecondaryButton(
                when {
                    descriptor.isAudio -> s.t("media.playAudio")
                    descriptor.kind == "talk" -> s.t("media.playTalk")
                    else -> s.t("media.playIntro")
                },
                { attempt++ },
            )
            is LoadState.Loading -> DownloadProgress(st.p)
            is LoadState.Failed -> ErrorCard(s.t("media.playError", "reason" to st.reason), { attempt++ }, s.t("error.state.retry"))
            is LoadState.Ready -> FilePlayer(st.file, descriptor, transcript, resumeAt, onProgress, content)
        }
        TranscriptBlock(transcript)
    }
}

@Composable
private fun DownloadProgress(p: MediaFiles.Progress?) {
    val s = LocalStrings.current
    val ctx = LocalContext.current
    fun fmt(n: Long) = Formatter.formatShortFileSize(ctx, n)
    val total = p?.total?.takeIf { it > 0 }
    val stage = when {
        p == null -> s.t("media.connecting")
        p.decrypting -> s.t("media.decrypting")
        total != null -> s.t("media.downloadingOf", "done" to fmt(p.received), "total" to fmt(total))
        else -> s.t("media.downloading", "done" to fmt(p.received))
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (p != null && total != null && !p.decrypting) LinearProgressIndicator(progress = { (p.received.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
        else LinearProgressIndicator(Modifier.fillMaxWidth())
        Dim(stage, size = 13)
    }
}

/** Speed choice shared by both players (1×, 1.5×, 2×), persisted across talks. */
@Composable
fun SpeedRow(rate: Float, onRate: (Float) -> Unit) {
    val s = LocalStrings.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Dim(s.t("media.speed"), size = 13)
        Content.SPEEDS.forEach { r ->
            SmallButton((if (r % 1f == 0f) r.toInt().toString() else r.toString()) + "×", { onRate(r) }, selected = rate == r)
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun FilePlayer(file: File, d: MediaDescriptor, transcript: MediaTranscript?, resumeAt: Long, onProgress: ((Long) -> Unit)?, content: Content) {
    val ctx = LocalContext.current
    val s = LocalStrings.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var rate by remember { mutableFloatStateOf(content.playbackRate()) }
    var playing by remember { mutableStateOf(false) }
    val captions = remember(file, transcript?.text) {
        transcript?.text?.takeIf { it.isNotBlank() }?.let { text ->
            File(ctx.cacheDir, "talk-captions").apply { mkdirs() }.resolve("${d.x}.vtt").apply { writeText(Vtt.forTranscript(text, d.duration)) }
        }
    }
    val player = remember(file) {
        val item = MediaItem.Builder().setUri(Uri.fromFile(file)).apply {
            captions?.let {
                setSubtitleConfigurations(listOf(
                    MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(it))
                        .setMimeType(MimeTypes.TEXT_VTT)
                        .setLanguage(transcript?.lang)
                        .setLabel(s.t("media.captionsLabel"))
                        .setSelectionFlags(0) // not default: the viewer turns captions on
                        .build(),
                ))
            }
        }.build()
        ExoPlayer.Builder(ctx).build().apply {
            setMediaItem(item)
            setPlaybackSpeed(rate)
            prepare()
        }
    }
    DisposableEffect(player) {
        var resumed = false
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY && !resumed) {
                    resumed = true
                    val dur = player.duration
                    if (resumeAt > 0 && (dur == C.TIME_UNSET || resumeAt * 1000 < dur - 1000)) player.seekTo(resumeAt * 1000)
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
                if (!isPlaying) onProgress?.invoke(player.currentPosition / 1000)
            }
        }
        player.addListener(listener)
        // Never keep playing behind the user's back once the app leaves the screen.
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) player.pause() }
        lifecycle.addObserver(obs)
        onDispose {
            onProgress?.invoke(player.currentPosition / 1000)
            lifecycle.removeObserver(obs)
            player.removeListener(listener)
            player.release()
            captions?.delete()
        }
    }
    // Report the position about every 5 s of playback, only while playing.
    LaunchedEffect(player, playing) {
        while (playing && onProgress != null) {
            delay(5_000)
            onProgress(player.currentPosition / 1000)
        }
    }
    val t = LocalTokens.current
    AndroidView(
        factory = { context ->
            PlayerView(context).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                this.player = player
                setShowSubtitleButton(captions != null)
                if (d.isAudio) { controllerShowTimeoutMs = 0; controllerHideOnTouch = false; useArtwork = false }
            }
        },
        update = { it.player = player },
        modifier = (if (d.isAudio) Modifier.fillMaxWidth().height(110.dp) else Modifier.fillMaxWidth().aspectRatio(16f / 9f))
            .clip(RoundedCornerShape(12.dp)).background(if (d.isAudio) t.bgElev2 else Color.Black),
    )
    SpeedRow(rate) { r -> rate = r; player.setPlaybackSpeed(r); content.setPlaybackRate(r) }
}

/** The nonvisual path (audit A1): a readable transcript, or an honest "unavailable". */
@Composable
fun TranscriptBlock(transcript: MediaTranscript?) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    var show by remember { mutableStateOf(false) }
    val text = transcript?.text?.takeIf { it.isNotBlank() }
    if (text == null) { Dim(s.t("media.captionsUnavailable"), size = 13); return }
    LinkButton(if (show) s.t("media.hideTranscript") else s.t("media.showTranscript"), { show = !show })
    if (show) SoftCard(color = t.bgElev2) {
        if (transcript.source == "stt") Dim(s.t("media.transcript.machine"), size = 12)
        Text(text, fontSize = 15.sp, lineHeight = 22.sp)
    }
}
