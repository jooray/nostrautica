package today.cypherpunk.nostrautica.domain.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Start / stop / "Try again" for a chat session's run, with at most ONE run alive
 * at any time (audit KIMIK31 A-1).
 *
 * Each launch waits for the job before it, and the wait is non-cancellable. It used
 * to be a plain `join`, so cancelling a launch that was still waiting (a second
 * "Try again", or stop then start again) ended it at once. The next launch then
 * started a run while the first was still unwinding: a blocking native call ignores
 * cancellation. Both runs then shared the session's fields, and either one's
 * `finally` could null the other's account ref, unbind its group or cancel its
 * timeline. Now a cancelled launch still waits for its predecessor to finish, then
 * skips its own run, so launches form a chain and runs never overlap.
 */
internal class SessionRuns(private val scope: CoroutineScope) {
    private var job: Job? = null
    /** A run [stop] cancelled that may still be unwinding. */
    private var stopping: Job? = null

    /** Start unless a run is active; [prepare] runs right before [run], once the previous run has ended. */
    @Synchronized
    fun start(prepare: () -> Unit, run: suspend () -> Unit) {
        if (job?.isActive == true) return
        launch(stopping ?: job, cancelPrevious = false, prepare, run)
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        stopping = job ?: stopping
        job = null
    }

    /** Cancel whatever runs, wait for it to end completely, then run afresh. */
    @Synchronized
    fun retry(prepare: () -> Unit, run: suspend () -> Unit) {
        launch(job ?: stopping, cancelPrevious = true, prepare, run)
    }

    private fun launch(previous: Job?, cancelPrevious: Boolean, prepare: () -> Unit, run: suspend () -> Unit) {
        stopping = null
        if (cancelPrevious) previous?.cancel()
        job = scope.launch {
            withContext(NonCancellable) { previous?.join() }
            currentCoroutineContext().ensureActive()
            prepare()
            run()
        }
    }
}
