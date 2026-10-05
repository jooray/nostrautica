/** @module @category Core - App Components */
import { type ClientState, type ProposalWithSender } from "../../vendor/ts-mls/index.js";
export type DisbandClassification = {
    kind: "notDisband";
} | {
    kind: "validDisband";
    actorPubkey: string;
} | {
    kind: "validEnablement";
    actorPubkey: string;
} | {
    kind: "violation";
    detail: string;
};
/** Classifies lifecycle enablement and terminal commits against their authenticated parent. */
export declare function classifyDisbandCommit(args: {
    parentState: ClientState;
    resultingState: ClientState;
    proposals: readonly ProposalWithSender[];
    committerLeafIndex: number | undefined;
}): DisbandClassification;
