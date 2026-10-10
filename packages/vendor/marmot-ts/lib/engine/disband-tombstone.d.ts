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
/** Non-secret, scrubbed MLS shell used only to construct the terminal facade. */
export declare function disbandRegistryStateKey(groupIdHex: string): string;
export declare function encodeDisbandTombstone(tombstone: DisbandTombstone): Uint8Array;
export declare function decodeDisbandTombstone(data: Uint8Array): DisbandTombstone;
