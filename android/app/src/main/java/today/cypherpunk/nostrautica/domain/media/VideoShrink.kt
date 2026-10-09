package today.cypherpunk.nostrautica.domain.media

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.container.Mp4OrientationData
import androidx.media3.container.Mp4TimestampData
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume

/** The size/rate rules for intro and talk video, pure so they are unit-tested. */
object VideoRules {
    const val MAX_SHORT_SIDE = 720
    const val MAX_FPS = 30

    /** Downscale so the shorter side is at most 720 px; never upscale; even dimensions. */
    fun targetSize(w: Int, h: Int, maxShort: Int = MAX_SHORT_SIDE): Pair<Int, Int> {
        val short = minOf(w, h)
        if (short <= maxShort) return even(w) to even(h)
        val scale = maxShort.toDouble() / short
        return even((w * scale).toInt()) to even((h * scale).toInt())
    }

    private fun even(v: Int) = maxOf(2, v - v % 2)

    /** ~0.08 bits per pixel per frame, between 0.8 and 2.5 Mbit/s, never above the source. */
    fun bitrate(w: Int, h: Int, fps: Float, sourceBitrate: Int): Int {
        val f = if (fps <= 0f) MAX_FPS.toFloat() else minOf(fps, MAX_FPS.toFloat())
        val target = (w.toLong() * h * f * 0.08).toInt().coerceIn(800_000, 2_500_000)
        return if (sourceBitrate in 1 until target) sourceBitrate else target
    }

    fun needsReencode(w: Int, h: Int, fps: Float, sourceBitrate: Int): Boolean =
        minOf(w, h) > MAX_SHORT_SIDE || fps > MAX_FPS + 1 || sourceBitrate > 3_000_000
}

/**
 * Re-encodes video on the phone before upload (Media3 Transformer, hardware H.264
 * + AAC): shorter side ≤ 720 px, ≤ 30 fps. The PWA uploads the raw recording; an
 * intro shrinks from tens of MB to a few, which is the whole upload on venue Wi-Fi.
 *
 * Location and other container metadata are dropped (only orientation and the
 * creation timestamp survive), so a picked phone video never publishes where it
 * was shot. Returns null when the clip can't be processed; the caller decides.
 */
@OptIn(UnstableApi::class)
class VideoShrink(private val context: Context) {
    private val dir = File(context.cacheDir, "recordings").apply { mkdirs() }

    data class Probe(val width: Int, val height: Int, val fps: Float, val bitrate: Int, val durationSec: Double, val hasVideo: Boolean)

    fun probe(uri: Uri): Probe? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(context, uri)
            val hasVideo = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"
            val durMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
            val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val br = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull() ?: 0
            val quarter = rot == 90 || rot == 270
            Probe(if (quarter) h else w, if (quarter) w else h, if (hasVideo) frameRate(uri) else 0f, br, durMs / 1000.0, hasVideo)
        } catch (e: Exception) {
            null
        } finally {
            runCatching { r.release() }
        }
    }

    private fun frameRate(uri: Uri): Float {
        val ex = MediaExtractor()
        return try {
            ex.setDataSource(context, uri, null)
            (0 until ex.trackCount).map { ex.getTrackFormat(it) }
                .firstOrNull { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
                ?.let { f ->
                    if (!f.containsKey(MediaFormat.KEY_FRAME_RATE)) 0f
                    else runCatching { f.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat() }.getOrElse { f.getFloat(MediaFormat.KEY_FRAME_RATE) }
                } ?: 0f
        } catch (e: Exception) {
            0f
        } finally {
            ex.release()
        }
    }

    /**
     * Shrink (and strip) [input]. With [always] false a file already inside the
     * limits is returned as-is (our own CameraX recordings carry no location).
     */
    suspend fun shrink(input: Uri, always: Boolean, onProgress: (Int) -> Unit = {}): File? {
        val p = withContext(Dispatchers.IO) { probe(input) } ?: return null
        if (!p.hasVideo || p.width <= 0 || p.height <= 0) return null
        val reencode = VideoRules.needsReencode(p.width, p.height, p.fps, p.bitrate)
        if (!reencode && !always) return null
        val (w, h) = VideoRules.targetSize(p.width, p.height)
        val out = File(dir, "${UUID.randomUUID()}.mp4")
        val effects = if (!reencode) emptyList() else buildList {
            add(Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT))
            if (p.fps > VideoRules.MAX_FPS + 1) add(FrameDropEffect.createDefaultFrameDropEffect(VideoRules.MAX_FPS.toFloat()))
        }
        val item = EditedMediaItem.Builder(MediaItem.fromUri(input)).setEffects(Effects(emptyList(), effects)).build()
        val composition = Composition.Builder(EditedMediaItemSequence.withAudioAndVideoFrom(listOf(item)))
            .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
            .build()
        val ok = withContext(Dispatchers.Main) { export(composition, out, VideoRules.bitrate(w, h, p.fps, p.bitrate), reencode, onProgress) }
        if (!ok || out.length() == 0L) { out.delete(); return null }
        return out
    }

    private suspend fun export(composition: Composition, out: File, bitrate: Int, reencode: Boolean, onProgress: (Int) -> Unit): Boolean = coroutineScope {
        var transformer: Transformer? = null
        val progress = launch {
            val holder = ProgressHolder()
            while (true) {
                delay(500)
                if (transformer?.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress.coerceIn(0, 99))
            }
        }
        // Keep only what playback needs: orientation and the creation time. Location goes.
        val muxer = InAppMp4Muxer.Factory { entries -> entries.retainAll { it is Mp4OrientationData || it is Mp4TimestampData } }
        try {
            suspendCancellableCoroutine { cont ->
                val b = Transformer.Builder(context).setMuxerFactory(muxer)
                if (reencode) {
                    b.setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
                        .setEncoderFactory(
                            DefaultEncoderFactory.Builder(context)
                                .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                                .setEnableFallback(true).build(),
                        )
                }
                val t = b.addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) { if (cont.isActive) cont.resume(true) }
                    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) { if (cont.isActive) cont.resume(false) }
                }).build()
                transformer = t
                cont.invokeOnCancellation { t.cancel() }
                t.start(composition, out.path)
            }
        } finally {
            progress.cancel()
        }
    }
}
