package today.cypherpunk.nostrautica.domain.media

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID
import kotlin.math.abs

/** What a finished take is (capture.ts CaptureResult). */
data class Take(val file: File, val mime: String, val durationSec: Double)

/** A media file's container duration in seconds, or null if it can't be read. */
fun fileDurationSec(f: File): Double? = runCatching {
    val r = android.media.MediaMetadataRetriever()
    try {
        r.setDataSource(f.path)
        r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.takeIf { it > 0 }?.let { it / 1000.0 }
    } finally { r.release() }
}.getOrNull()

/** Countdown/elapsed ticks for a capped or unlimited take (capture.ts onTick). */
object CaptureClock {
    /** Seconds left for a capped take, or seconds elapsed (counting up) when unlimited. */
    fun tick(elapsedMs: Long, maxSec: Int): Int =
        if (maxSec <= 0) (elapsedMs / 1000).toInt() else maxOf(0, Math.ceil(maxSec - elapsedMs / 1000.0).toInt())
}

private fun newFile(context: Context, ext: String) = File(File(context.cacheDir, "recordings").apply { mkdirs() }, "${UUID.randomUUID()}.$ext")

/**
 * A live microphone level (0..1) for the meter, from AudioRecord, before a take
 * starts (the PWA's Web Audio analyser). Stop it before recording: only one client
 * should hold the mic.
 */
class LevelMeter {
    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> get() = _level
    private var job: Job? = null

    @SuppressLint("MissingPermission")
    fun start(scope: CoroutineScope) {
        if (job != null) return
        job = scope.launch(Dispatchers.IO) {
            val rate = 16_000
            val size = maxOf(AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), 2048)
            val rec = runCatching { AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size) }.getOrNull() ?: return@launch
            try {
                if (rec.state != AudioRecord.STATE_INITIALIZED) return@launch
                rec.startRecording()
                val buf = ShortArray(size / 2)
                while (isActive) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) { delay(50); continue }
                    var peak = 0
                    for (i in 0 until n) peak = maxOf(peak, abs(buf[i].toInt()))
                    _level.value = (peak / 32768f).coerceIn(0f, 1f)
                }
            } finally {
                runCatching { rec.stop() }
                rec.release()
                _level.value = 0f
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        _level.value = 0f
    }
}

/** Audio-only intro: AAC in MP4 (`audio/mp4`), small and universally playable. */
class AudioTake(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    fun start() {
        val f = newFile(context, "m4a")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioChannels(1)
        r.setAudioSamplingRate(44_100)
        r.setAudioEncodingBitRate(64_000)
        r.setOutputFile(f.path)
        r.prepare()
        r.start()
        recorder = r
        file = f
        startedAt = System.currentTimeMillis()
    }

    /** 0..1 since the last call (MediaRecorder.getMaxAmplitude). */
    fun level(): Float = runCatching { (recorder?.maxAmplitude ?: 0) / 32767f }.getOrDefault(0f).coerceIn(0f, 1f)

    fun stop(): Take? {
        val r = recorder ?: return null
        recorder = null
        val ok = runCatching { r.stop() }.isSuccess
        r.release()
        val f = file ?: return null
        if (!ok || f.length() == 0L) { f.delete(); return null }
        return Take(f, "audio/mp4", fileDurationSec(f) ?: ((System.currentTimeMillis() - startedAt) / 1000.0))
    }

    fun cancel() {
        recorder?.let { runCatching { it.stop() }; it.release() }
        recorder = null
        file?.delete()
    }
}

/**
 * Front-camera video with CameraX: preview into a [PreviewView], record H.264 at
 * up to 720p (2 Mbit/s) straight to a cache file. Location is never attached.
 */
class CameraTake(private val context: Context) {
    private var provider: ProcessCameraProvider? = null
    private var capture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private val _level = MutableStateFlow(0f)
    /** Mic amplitude while recording (CameraX AudioStats). */
    val level: StateFlow<Float> get() = _level

    suspend fun bind(owner: LifecycleOwner, view: PreviewView, front: Boolean) {
        val p = ProcessCameraProvider.awaitInstance(context)
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
        val recorder = Recorder.Builder()
            .setQualitySelector(QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
            .setTargetVideoEncodingBitRate(2_000_000)
            .build()
        val vc = VideoCapture.withOutput(recorder)
        val selector = if (front && p.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
        p.unbindAll()
        p.bindToLifecycle(owner, selector, preview, vc)
        provider = p
        capture = vc
    }

    /** Record until [stop] or [maxSec] (0 = unlimited); resolves with the take. */
    @SuppressLint("MissingPermission")
    suspend fun record(maxSec: Int): Take {
        val vc = capture ?: throw IllegalStateException("camera not bound")
        val f = newFile(context, "mp4")
        val opts = FileOutputOptions.Builder(f).apply { if (maxSec > 0) setDurationLimitMillis(maxSec * 1000L) }.build()
        val done = CompletableDeferred<Take>()
        val started = System.currentTimeMillis()
        recording = vc.output.prepareRecording(context, opts).withAudioEnabled()
            .start(ContextCompat.getMainExecutor(context)) { e ->
                when (e) {
                    is VideoRecordEvent.Status -> _level.value = e.recordingStats.audioStats.audioAmplitude.toFloat().coerceIn(0f, 1f)
                    is VideoRecordEvent.Finalize -> {
                        _level.value = 0f
                        // A duration-limit stop, or the app going to the background, still leaves a usable file.
                        val ok = !e.hasError() || e.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
                            e.error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE
                        if (ok && f.length() > 0) {
                            // The finished file's own duration is the truth; the recorder's
                            // stats follow the audio clock, which is not always sane.
                            val nanos = e.recordingStats.recordedDurationNanos
                            val sec = fileDurationSec(f) ?: if (nanos > 0) nanos / 1e9 else (System.currentTimeMillis() - started) / 1000.0
                            done.complete(Take(f, "video/mp4", sec))
                        } else {
                            f.delete()
                            done.completeExceptionally(e.cause ?: IllegalStateException("recording failed (${e.error})"))
                        }
                    }
                    else -> {}
                }
            }
        return done.await()
    }

    fun stop() { recording?.stop(); recording = null }

    /** Release the camera (the light goes out the moment a take is done). */
    fun release() {
        recording?.close()
        recording = null
        provider?.unbindAll()
        capture = null
    }
}
