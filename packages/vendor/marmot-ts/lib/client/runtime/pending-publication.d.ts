import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { PublishResponse } from "../nostr-interface.js";
import type { GroupPublishWork } from "../session/group-effects.js";
type CommitWork = Extract<GroupPublishWork, {
    kind: "groupEvolution" | "selfUpdate";
}>;
export declare function pendingPublicationKey(groupId: string): string;
export interface PendingPublication {
    work: CommitWork;
    relays: string[];
    acknowledged: boolean;
    uncertain?: boolean;
    response?: Record<string, PublishResponse>;
}
/** Local storage is trusted to the same extent as the canonical MLS state store. */
export declare class PendingPublicationStore {
    #private;
    readonly store: GenericKeyValueStore<Uint8Array>;
    constructor(store: GenericKeyValueStore<Uint8Array>, groupId: string);
    read(): Promise<PendingPublication | undefined>;
    write(record: PendingPublication): Promise<void>;
    clear(): Promise<void>;
}
export {};
