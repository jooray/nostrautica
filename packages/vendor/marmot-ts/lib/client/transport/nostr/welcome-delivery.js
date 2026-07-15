import { createWelcomeRumor } from "../../../core/welcome.js";
import { createGiftWrap } from "../../../utils/index.js";
/** Owns Nostr/NIP-59 Welcome wrapping and inbox publication. */
export class NostrWelcomeDelivery {
    signer;
    network;
    constructor(options) {
        this.signer = options.signer;
        this.network = options.network;
    }
    createRumor(options) {
        return createWelcomeRumor({
            welcome: options.welcome,
            author: options.author,
            groupRelays: options.groupRelays,
            keyPackageEventId: options.recipient.keyPackageEventId,
        });
    }
    async deliver(options) {
        const welcomeRumor = this.createRumor(options);
        const giftWrapEvent = await createGiftWrap({
            rumor: welcomeRumor,
            recipient: options.recipient.pubkey,
            signer: this.signer,
        });
        let inboxRelays;
        try {
            inboxRelays = await this.network.getUserInboxRelays(options.recipient.pubkey);
        }
        catch {
            inboxRelays = options.groupRelays;
        }
        if (inboxRelays.length === 0) {
            throw new Error(`No relays available to send Welcome to recipient ${options.recipient.pubkey.slice(0, 16)}...`);
        }
        return this.network.publish(inboxRelays, giftWrapEvent);
    }
}
//# sourceMappingURL=welcome-delivery.js.map