/** @module @category Client - Group */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { ClientState, MlsMessage } from "../../vendor/ts-mls/index.js";
import type { GroupMessageWrapOptions, GroupPeeler, PeeledMessagePair } from "../../engine/types.js";
/** Nostr kind-445 peeler for {@link MarmotGroupEngine}. */
export declare class NostrGroupPeeler implements GroupPeeler<NostrEvent> {
    private readonly ciphersuite;
    constructor(ciphersuite: import("../../vendor/ts-mls/index.js").CiphersuiteImpl);
    peelGroupMessages(envelopes: NostrEvent[], state: ClientState): Promise<{
        read: PeeledMessagePair<NostrEvent>[];
        unreadable: NostrEvent[];
    }>;
    wrapGroupMessage(message: MlsMessage, state: ClientState, options?: GroupMessageWrapOptions): Promise<NostrEvent>;
    idOf(envelope: NostrEvent): string;
}
