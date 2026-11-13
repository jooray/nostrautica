package today.cypherpunk.nostrautica.domain.chat

import kotlinx.coroutines.CancellationException

/**
 * The automatic-attestation latches of one chat session, and the rule that a
 * REQUIRED key-package rotation must succeed before the `add` goes out (audit
 * KIMIK31 A-2).
 *
 * The policy asks for a rotation exactly when the advertised key package is likely
 * spent or ineligible (evicted, listed-but-holding-nothing, a key-package refusal).
 * Sending the `add` anyway re-advertised that same package, and the add consumed
 * the ten-minute spacing and, for a refusal, the one retry: the device could not
 * be added, believed it had attested, and had spent its recovery on it. Now a
 * failed rotation sends nothing and consumes nothing; it is tried again after
 * [ROTATE_RETRY_MS].
 */
internal class Enrolment(private val clock: () -> Long = System::currentTimeMillis) {
    /** When this process last sent an `add` (0: never). Survives "Try again" on purpose. */
    var lastAttestMs = 0L
        private set

    /** The one extra attempt after a fixable refusal has been used. */
    var refusalRetried = false
        private set

    /** When a required rotation last failed (0: it has not). */
    private var rotateFailedAtMs = 0L

    /** Whether [decision] may be acted on now. */
    fun allowed(decision: ChatPolicy.Decision, nowMs: Long, refusalRetry: Boolean): Boolean {
        if (!ChatPolicy.attestAllowed(decision, lastAttestMs, nowMs, refusalRetry)) return false
        val rotate = (decision as ChatPolicy.Decision.Attest).rotate
        return !(rotate && rotateFailedAtMs > 0 && nowMs - rotateFailedAtMs < ROTATE_RETRY_MS)
    }

    /**
     * Rotate first when [rotate], then [send]. Returns false, having sent nothing and
     * touched no latch, when the rotation failed. Cancellation propagates unchanged.
     */
    suspend fun enroll(rotate: Boolean, refusalRetry: Boolean, rotateKeyPackage: suspend () -> Unit, send: suspend () -> Unit): Boolean {
        if (rotate) {
            try {
                rotateKeyPackage()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                rotateFailedAtMs = clock()
                return false
            }
        }
        rotateFailedAtMs = 0
        lastAttestMs = clock()
        if (refusalRetry) refusalRetried = true
        send()
        return true
    }

    /** An `add` sent outside the automatic path (Rejoin) also spaces the next automatic one. */
    fun attestedNow() { lastAttestMs = clock() }

    companion object {
        /** A failed required rotation is not tried again sooner than this. */
        const val ROTATE_RETRY_MS = 60_000L
    }
}
