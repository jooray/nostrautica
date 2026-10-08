/** @module @category Client - Group */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { GroupSessionSendIntent } from "../session/group-effects.js";
import { type VerifyEventMethod } from "../verify.js";
/** Options for {@link createInviteIntent}. */
export type CreateInviteIntentOptions = {
    /** The invitee's KeyPackage event (kind 30443). */
    keyPackageEvent: NostrEvent;
    /**
     * The committing member's Nostr public key (hex) — usually the local signer.
     * Recorded as the commit actor on the resulting group event.
     */
    actorPubkey: string;
    /**
     * Injectable event verifier for the 30443 trust boundary (SEC-01), applied
     * to `keyPackageEvent` before it is trusted. This is the second 30443
     * consumption path — it bypasses `KeyPackageStore`/`KeyPackageManager.track()`
     * entirely, so it independently gates on the same verify/cardinality/
     * lifetime rules. Defaults to applesauce's `verifyEvent`.
     */
    verifyEvent?: VerifyEventMethod;
};
/**
 * Builds a `commit` session intent that adds a user from their KeyPackage event
 * and delivers a Welcome to them after the commit acks.
 *
 * Validates that the event is a KeyPackage (kind 30443), passes the trust
 * boundary (SEC-01: signature; WIRE-02: `d`/`i`/`mls_protocol_version`
 * cardinality; WIRE-01: Lifetime cap/current), that the embedded credential
 * identity matches the event author, and that the `mls_proposals` tag exactly
 * matches the leaf's advertised proposals — with GREASE included (MDK and
 * current marmot-ts) or with GREASE removed from both sides (older marmot-ts)
 * — before constructing the Add proposal. Pair the result with
 * {@link GroupSession.send} / {@link GroupsManager.send};
 * {@link GroupsManager.invite} wraps this helper and resolves `actorPubkey`
 * from the signer.
 *
 * @throws Error if the event is not a KeyPackage kind, fails signature
 *   verification, has invalid required-tag cardinality, has an over-long or
 *   not-current Lifetime, the credential identity does not match the event
 *   author, or the `mls_proposals` tag is absent, malformed, or does not match
 *   the leaf's advertised proposals (with or without GREASE).
 */
export declare function createInviteIntent(options: CreateInviteIntentOptions): Extract<GroupSessionSendIntent, {
    kind: "commit";
}>;
