/** @module @category Client - Nostr */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/factories";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Welcome } from "ts-mls";
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
/** Owns Nostr/NIP-59 Welcome wrapping and inbox publication. */
export declare class NostrWelcomeDelivery {
    readonly signer: EventSigner;
    readonly network: NostrNetworkInterface;
    constructor(options: NostrWelcomeDeliveryOptions);
    createRumor(options: DeliverWelcomeOptions): Rumor;
    deliver(options: DeliverWelcomeOptions): Promise<Record<string, PublishResponse>>;
}
