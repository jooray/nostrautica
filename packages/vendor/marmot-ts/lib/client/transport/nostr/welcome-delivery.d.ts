/** @module @category Client - Nostr */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/factories";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Welcome } from "../../../vendor/ts-mls/index.js";
import type { NostrNetworkInterface, PublishResponse } from "../../nostr-interface.js";
/** Information required to deliver an MLS Welcome to a new member. */
export type WelcomeRecipient = {
    /** The recipient's Nostr public key. */
    pubkey: string;
    /** The event id of the KeyPackage consumed by the Add. */
    keyPackageEventId: string;
    /** The KeyPackage event consumed by the Add. */
    keyPackageEvent: NostrEvent;
};
export type NostrWelcomeDeliveryOptions = {
    signer: EventSigner;
    network: NostrNetworkInterface;
};
export type DeliverWelcomeOptions = {
    welcome: Welcome;
    author: string;
    groupRelays: string[];
    recipient: WelcomeRecipient;
};
/**
 * The outcome of one recipient's Welcome delivery attempt, produced by
 * {@link NostrWelcomeDelivery.deliverMany}. This is the per-invitee unit of
 * FOUND-04: a Welcome "succeeds or fails independently and does not affect
 * canonical group state"
 * (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78).
 *
 * `succeeded` means at least one relay acknowledged (`ok: true`) the
 * gift-wrapped Welcome. `failed` covers both a thrown delivery attempt and a
 * publish that fulfilled but no relay acknowledged (CR-02,
 * 10-VERIFICATION.md).
 */
export type WelcomeDeliveryOutcome = {
    kind: "succeeded";
    recipient: WelcomeRecipient;
    response: Record<string, PublishResponse>;
} | {
    kind: "failed";
    recipient: WelcomeRecipient;
    error: string;
};
export type DeliverManyWelcomesOptions = {
    welcome: Welcome;
    author: string;
    groupRelays: string[];
    recipients: WelcomeRecipient[];
};
/** Owns Nostr/NIP-59 Welcome wrapping and inbox publication. */
export declare class NostrWelcomeDelivery {
    readonly signer: EventSigner;
    readonly network: NostrNetworkInterface;
    constructor(options: NostrWelcomeDeliveryOptions);
    createRumor(options: DeliverWelcomeOptions): Rumor;
    deliver(options: DeliverWelcomeOptions): Promise<Record<string, PublishResponse>>;
    /**
     * Delivers a Welcome to many recipients, one {@link deliver} call each.
     * This is the shared fanout D-06/D-07 puts on the class whose job is
     * Welcome delivery — reached by both {@link GroupRuntime} (ordinary invite)
     * and `GroupFactory` (founding create), so exactly one implementation
     * exists that cannot drift.
     *
     * Never throws and never aggregates: each recipient's settled result maps
     * to exactly one {@link WelcomeDeliveryOutcome} entry, in the order the
     * recipients were supplied. A Welcome failure is a normal per-recipient
     * outcome, not an error — see
     * refs/marmot/protocol-core/publish-lifecycle.md lines 66-78 ("succeeds or
     * fails independently and does not affect canonical group state").
     *
     * A fulfilled publish is only classified `succeeded` when the shared
     * `hasAck` helper (`src/utils/nostr.ts`) reports at least one acknowledging
     * relay — the same required-ack rule {@link GroupRuntime} applies to group
     * events. A fulfilled publish where no relay acknowledged is classified
     * `failed` (CR-02, 10-VERIFICATION.md), so an unacknowledged invitee stays
     * visible to `pendingWelcomes` and retryable (FOUND-04).
     */
    deliverMany(options: DeliverManyWelcomesOptions): Promise<WelcomeDeliveryOutcome[]>;
}
