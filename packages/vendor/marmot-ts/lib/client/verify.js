import { fakeVerifyEvent, verifyEvent } from "applesauce-core/helpers";
export { fakeVerifyEvent, verifyEvent };
/**
 * The default, injectable event verifier. Re-exports applesauce's
 * `verifyEvent`, which recomputes the NIP-01 id and checks the BIP-340
 * Schnorr signature, caching the boolean result on the event.
 *
 * Callers that trust their event source (e.g. a caller that has already
 * verified events upstream) may inject {@link fakeVerifyEvent} instead — do
 * not introduce a separate boolean skip-verification flag.
 */
export const defaultVerifyEvent = verifyEvent;
/**
 * Runs an injected {@link VerifyEventMethod} defensively: a malformed event
 * (e.g. a non-hex `pubkey`, a missing required field) can make the
 * underlying verifier (applesauce/nostr-tools `verifyEvent`) throw rather
 * than return `false` — it only wraps the Schnorr-verify step in a
 * try/catch, not its own event-hash serialization step. Callers gating an
 * inbound trust boundary must never let that propagate as an unhandled
 * exception (availability/DoS-adjacent); treat any thrown error as a failed
 * verification instead.
 */
export function safeVerifyEvent(verify, event) {
    try {
        return verify(event);
    }
    catch {
        return false;
    }
}
