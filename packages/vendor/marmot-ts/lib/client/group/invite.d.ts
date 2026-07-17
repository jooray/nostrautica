/** @module @category Client - Group */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { GroupSessionSendIntent } from "../session/group-effects.js";
/** Options for {@link createInviteIntent}. */
export type CreateInviteIntentOptions = {
    /** The invitee's KeyPackage event (kind 30443). */
    keyPackageEvent: NostrEvent;
    /**
     * The committing member's Nostr public key (hex) — usually the local signer.
     * Recorded as the commit actor on the resulting group event.
     */
    actorPubkey: string;
};
/**
 * Builds a `commit` session intent that adds a user from their KeyPackage event
 * and delivers a Welcome to them after the commit acks.
 *
 * Validates that the event is a KeyPackage (kind 30443) and that the embedded
 * credential identity matches the event author before constructing the Add
 * proposal. Pair the result with {@link GroupSession.send} /
 * {@link GroupsManager.send}; {@link GroupsManager.invite} wraps this helper and
 * resolves `actorPubkey` from the signer.
 *
 * @throws Error if the event is not a KeyPackage kind or the credential identity
 *   does not match the event author.
 */
export declare function createInviteIntent(options: CreateInviteIntentOptions): Extract<GroupSessionSendIntent, {
    kind: "commit";
}>;
