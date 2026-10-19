/** Whether the authenticated terminal notification still needs delivery. */
export type DisbandNotificationState = "pending" | "delivered";
/** Authenticated, read-only evidence retained after live MLS state is erased. */
export interface DisbandTombstone {
    readonly groupId: Uint8Array;
    readonly selectedEpoch: number;
    readonly commitDigest: Uint8Array;
    readonly actorPubkey: string;
    readonly notificationState: DisbandNotificationState;
}
export declare function disbandTombstoneKey(groupIdHex: string): string;
/** First durable terminal authority; includes the non-secret repair projection. */
export interface DisbandTerminalIntent {
    readonly tombstone: DisbandTombstone;
    readonly registryState: Uint8Array;
}
export declare function disbandTerminalIntentKey(groupIdHex: string): string;
export declare function encodeDisbandTerminalIntent(intent: DisbandTerminalIntent): Uint8Array;
export declare function decodeDisbandTerminalIntent(data: Uint8Array): DisbandTerminalIntent;
/** Non-secret, scrubbed MLS shell used only to construct the terminal facade. */
export declare function disbandRegistryStateKey(groupIdHex: string): string;
export declare function encodeDisbandTombstone(tombstone: DisbandTombstone): Uint8Array;
export declare function decodeDisbandTombstone(data: Uint8Array): DisbandTombstone;
