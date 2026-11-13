package today.cypherpunk.nostrautica.domain.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Audit KIMIK31 A-2: a required rotation that fails must not send the add or spend a latch. */
class EnrolmentTest {
    private var now = 1_000_000L
    private val e = Enrolment { now }
    private val rotateAttest = ChatPolicy.Decision.Attest(rotate = true, "removed, and no re-add arrived")
    private val plainAttest = ChatPolicy.Decision.Attest(rotate = false, "the roster does not list this device")

    @Test fun aFailedRotationSendsNothingAndKeepsBothLatches() = runBlocking {
        var sent = 0
        val ok = e.enroll(rotate = true, refusalRetry = true, rotateKeyPackage = { throw IllegalStateException("relay down") }) { sent++ }
        assertFalse(ok)
        assertEquals("no add on the spent key package", 0, sent)
        assertEquals("the ten-minute spacing is not consumed", 0L, e.lastAttestMs)
        assertFalse("the one refusal retry is still available", e.refusalRetried)
    }

    @Test fun aFailedRotationIsRetriedAfterABackoffNotOnEveryReconcile() = runBlocking {
        e.enroll(rotate = true, refusalRetry = false, rotateKeyPackage = { throw IllegalStateException() }) {}
        assertFalse(e.allowed(rotateAttest, now + 8_000, false))
        // A decision that needs no rotation is not held back by it.
        assertTrue(e.allowed(plainAttest, now + 8_000, false))
        assertTrue(e.allowed(rotateAttest, now + Enrolment.ROTATE_RETRY_MS, false))
    }

    @Test fun cancellationDuringRotationPropagatesAndSendsNothing() {
        var sent = 0
        try {
            runBlocking { e.enroll(rotate = true, refusalRetry = true, rotateKeyPackage = { throw CancellationException("stopping") }) { sent++ } }
            fail("cancellation was swallowed")
        } catch (_: CancellationException) {
        }
        assertEquals(0, sent)
        assertEquals(0L, e.lastAttestMs)
        assertFalse(e.refusalRetried)
    }

    @Test fun aSuccessfulRotationSendsAndSpendsTheLatches() = runBlocking {
        val order = mutableListOf<String>()
        assertTrue(e.enroll(rotate = true, refusalRetry = true, rotateKeyPackage = { order += "rotate" }) { order += "add" })
        assertEquals(listOf("rotate", "add"), order)
        assertEquals(now, e.lastAttestMs)
        assertTrue(e.refusalRetried)
        assertFalse(e.allowed(plainAttest, now + 1_000, false))
    }

    @Test fun noRotationNeededJustSends() = runBlocking {
        var sent = 0
        assertTrue(e.enroll(rotate = false, refusalRetry = false, rotateKeyPackage = { fail("not asked to rotate") }) { sent++ })
        assertEquals(1, sent)
        assertFalse(e.refusalRetried)
    }
}
