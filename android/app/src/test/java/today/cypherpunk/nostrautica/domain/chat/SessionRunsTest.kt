package today.cypherpunk.nostrautica.domain.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Audit KIMIK31 A-1: a second "Try again" (or stop, start, stop, start) while the
 * first run is still unwinding through a call that ignores cancellation must not
 * start a second run beside it.
 */
class SessionRunsTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val runs = SessionRuns(scope)
    private val alive = AtomicInteger()
    private val maxAlive = AtomicInteger()
    private val started = AtomicInteger()

    @After fun down() = scope.cancel()

    /** The first run blocks in a "native" call that cancellation cannot interrupt, until [release]. */
    private val release = CompletableDeferred<Unit>()
    private var firstStarted = CompletableDeferred<Unit>()

    private suspend fun run() {
        val n = started.incrementAndGet()
        maxAlive.accumulateAndGet(alive.incrementAndGet(), ::maxOf)
        try {
            if (n == 1) {
                firstStarted.complete(Unit)
                withContext(NonCancellable) { release.await() }
            }
            awaitCancellation()
        } finally {
            alive.decrementAndGet()
        }
    }

    private suspend fun settle() = delay(200)

    @Test fun twoRetriesWhileTheFirstRunIsStuckStartOneRunAfterIt() = runBlocking {
        runs.start({}) { run() }
        withTimeout(2_000) { firstStarted.await() }
        runs.retry({}) { run() }
        settle()
        runs.retry({}) { run() }
        settle()
        assertEquals("nothing may start while the first run is unwinding", 1, started.get())
        release.complete(Unit)
        settle()
        assertEquals(1, maxAlive.get())
        assertEquals("the cancelled first retry is skipped; only the last one runs", 2, started.get())
        assertEquals(1, alive.get())
    }

    @Test fun stopStartStopStartWhileStuckNeverOverlaps() = runBlocking {
        runs.start({}) { run() }
        withTimeout(2_000) { firstStarted.await() }
        runs.stop()
        runs.start({}) { run() }
        settle()
        runs.stop()
        runs.start({}) { run() }
        settle()
        assertEquals(1, started.get())
        release.complete(Unit)
        settle()
        assertEquals(1, maxAlive.get())
        assertEquals(2, started.get())
    }

    @Test fun prepareRunsOnlyOnceThePreviousRunHasEnded() = runBlocking {
        runs.start({}) { run() }
        withTimeout(2_000) { firstStarted.await() }
        val prepared = AtomicInteger()
        runs.retry({ prepared.incrementAndGet() }) { run() }
        settle()
        assertEquals(0, prepared.get())
        release.complete(Unit)
        settle()
        assertEquals(1, prepared.get())
    }
}
