package today.cypherpunk.nostrautica

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

/**
 * Debug builds only: when the main thread has not run a posted no-op for
 * [STALL_MS], log what it is doing (its stack) and every other thread that is
 * BLOCKED or WAITING, every [STALL_MS] until it recovers.
 *
 * A Choreographer "Skipped N frames" line says only that a stall happened; this
 * says where, without root (`kill -3` traces land in /data/anr, which a user build
 * keeps from the shell). Read it with `adb logcat -s MainThreadWatchdog`.
 */
object MainThreadWatchdog {
    private const val TAG = "MainThreadWatchdog"
    private const val STALL_MS = 1_500L

    fun start() {
        val main = Handler(Looper.getMainLooper())
        val mainThread = Looper.getMainLooper().thread
        Thread({
            while (true) {
                val seen = java.util.concurrent.atomic.AtomicBoolean(false)
                val posted = SystemClock.uptimeMillis()
                main.postAtFrontOfQueue { seen.set(true) }
                Thread.sleep(STALL_MS)
                var reported = false
                while (!seen.get()) {
                    val stalled = SystemClock.uptimeMillis() - posted
                    val sb = StringBuilder("main thread stalled ${stalled} ms (${mainThread.state})\n")
                    mainThread.stackTrace.forEach { sb.append("    at ").append(it).append('\n') }
                    if (!reported) {
                        for ((t, st) in Thread.getAllStackTraces()) {
                            if (t === mainThread || st.isEmpty()) continue
                            if (t.state != Thread.State.BLOCKED && t.state != Thread.State.WAITING && t.state != Thread.State.TIMED_WAITING) continue
                            val top = st.take(12)
                            if (top.none { it.className.startsWith("today.cypherpunk") || it.className.startsWith("dev.ipf") }) continue
                            sb.append("  thread \"").append(t.name).append("\" ").append(t.state).append('\n')
                            top.forEach { sb.append("    at ").append(it).append('\n') }
                        }
                        reported = true
                    }
                    sb.toString().chunked(3500).forEach { Log.w(TAG, it) }
                    Thread.sleep(STALL_MS)
                }
                Thread.sleep(500)
            }
        }, "main-watchdog").apply { isDaemon = true }.start()
    }
}
