import { createGroupEvent, decryptGroupMessages, } from "../../core/group-message.js";
/** Nostr kind-445 peeler for {@link MarmotGroupEngine}. */
export class NostrGroupPeeler {
    ciphersuite;
    constructor(ciphersuite) {
        this.ciphersuite = ciphersuite;
    }
    async peelGroupMessages(envelopes, state) {
        const { read, unreadable } = await decryptGroupMessages(envelopes, state, this.ciphersuite);
        return {
            read: read.map(({ event, message }) => ({ envelope: event, message })),
            unreadable,
        };
    }
    async wrapGroupMessage(message, state, metadata) {
        return createGroupEvent({
            message,
            state,
            ciphersuite: this.ciphersuite,
            metadata,
        });
    }
    idOf(envelope) {
        return envelope.id;
    }
}
