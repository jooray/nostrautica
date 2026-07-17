/** @module @category Client - Runtime */
import type { Debugger } from "debug";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { MarmotGroupView } from "../../core/client-state.js";
import { type AuditContextOptions, type AuditSink } from "../../audit/index.js";
import type { PendingState } from "../../engine/types.js";
import type { GroupEffects, GroupPublishResult, GroupPublishWork } from "../session/group-effects.js";
import type { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { NostrWelcomeDelivery, type WelcomeRecipient } from "../transport/nostr/welcome-delivery.js";
export type GroupRuntimeOptions = {
    welcomeDelivery: NostrWelcomeDelivery;
    getNetwork: () => NostrNetworkInterface;
    getRelays: () => string[] | undefined;
    getGroupRef: () => string;
    getGroupData: () => MarmotGroupView | null;
    confirmPublished: (pending: PendingState) => void;
    publishFailed: (pending: PendingState) => void;
    save: () => Promise<void>;
    log?: Debugger;
    audit?: AuditSink;
    auditContext?: AuditContextOptions;
};
export type PublishCommitOptions = {
    envelope: NostrEvent;
    pending: PendingState;
    actorPubkey: string;
    welcome?: {
        welcome?: import("ts-mls").Welcome;
    };
    welcomeRecipients?: WelcomeRecipient[];
};
/** Drives group publish effects through Nostr and confirms or rolls back state. */
export declare class GroupRuntime {
    #private;
    readonly welcomeDelivery: NostrWelcomeDelivery;
    constructor(options: GroupRuntimeOptions);
    publishEffects(effects: GroupEffects): Promise<GroupPublishResult[]>;
    publishWork(work: GroupPublishWork): Promise<Record<string, PublishResponse>>;
    publishApplication(envelope: NostrEvent): Promise<Record<string, PublishResponse>>;
    publishProposal(envelope: NostrEvent, pending: PendingState): Promise<Record<string, PublishResponse>>;
    publishSelfUpdate(envelope: NostrEvent, pending: PendingState): Promise<Record<string, PublishResponse>>;
    publishCommit(options: PublishCommitOptions): Promise<Record<string, PublishResponse>>;
}
