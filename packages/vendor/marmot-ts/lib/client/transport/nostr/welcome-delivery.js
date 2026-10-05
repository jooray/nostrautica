import { createWelcomeRumor } from "../../../core/welcome.js";
import { createGiftWrap, hasAck } from "../../../utils/index.js";
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
    async deliverMany(options) {
        const settled = await Promise.allSettled(options.recipients.map((recipient) => this.deliver({
            welcome: options.welcome,
            author: options.author,
            groupRelays: options.groupRelays,
            recipient,
        })));
        return settled.map((result, index) => {
            const recipient = options.recipients[index];
            if (result.status === "fulfilled") {
                if (hasAck(result.value))
                    return { kind: "succeeded", recipient, response: result.value };
                const rejections = Object.values(result.value)
                    .filter((r) => !r.ok)
                    .map((r) => `${r.from}: ${r.message ?? "rejected"}`)
                    .join("; ");
                const error = `No relay accepted the Welcome` +
                    (rejections ? ` (${rejections})` : "");
                return { kind: "failed", recipient, error };
            }
            const error = result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            return { kind: "failed", recipient, error };
        });
    }
}
