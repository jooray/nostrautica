import type { Debugger } from "debug";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { MarmotGroupView } from "../../core/client-state.js";
import { type AuditContextOptions, type AuditSink } from "../../audit/index.js";
import type { PendingState } from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import { PendingPublicationStore } from "./pending-publication.js";
import type { GroupEffects, GroupPublishResult, GroupPublishWork } from "../session/group-effects.js";
import type { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { NostrWelcomeDelivery, type WelcomeRecipient } from "../transport/nostr/welcome-delivery.js";
export type GroupRuntimeOptions = {
    welcomeDelivery: NostrWelcomeDelivery;
    getNetwork: () => NostrNetworkInterface;
    getRelays: () => string[] | undefined;
    getGroupRef: () => string;
    getGroupData: () => MarmotGroupView | null;
    confirmPublished: (pending: PendingState) => StateNotification[];
    publishFailed: (pending: PendingState) => void;
    save: () => Promise<void>;
    /** @internal Recovery storage supplied by the group owner. */
    pendingPublications?: PendingPublicationStore;
    restorePending?: (pending: PendingState) => void;
    isApplied?: (pending: PendingState) => boolean;
    /** Owner admission fence, checked before transport and after awaits. */
    assertOpen?: () => void;
    log?: Debugger;
    audit?: AuditSink;
    auditContext?: AuditContextOptions;
};
export type PublishCommitOptions = {
    envelope: NostrEvent;
    pending: PendingState;
    actorPubkey: string;
    welcome?: {
        welcome?: import("../../vendor/ts-mls/index.js").Welcome;
    };
    welcomeRecipients?: WelcomeRecipient[];
    /** Admission fence; cancellation stops being reversible once publish starts. */
    signal?: AbortSignal;
};
/** An exact commit remains pending; retry it rather than preparing a replacement. */
export declare class PublicationUncertainError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** Drives group publish effects through Nostr and confirms or rolls back state. */
export declare class GroupRuntime {
    #private;
    readonly welcomeDelivery: NostrWelcomeDelivery;
    constructor(options: GroupRuntimeOptions);
    /** Restore the publish gate before admitting inbound or new outbound work. */
    hydratePublication(): Promise<void>;
    /** Retry the original signed event and exact pending state after a lost ACK. */
    retryPendingPublication(): Promise<GroupPublishResult[]>;
    publishEffects(effects: GroupEffects): Promise<GroupPublishResult[]>;
    publishWork(work: GroupPublishWork): Promise<Record<string, PublishResponse>>;
    /**
     * Publish the original signed envelope on every attempt. Its timestamp,
     * ciphertext and source-epoch expiration are fixed before signing; retries
     * must reuse this artifact even after the current group policy changes.
     */
    publishApplication(envelope: NostrEvent): Promise<Record<string, PublishResponse>>;
    publishProposal(envelope: NostrEvent, pending: PendingState): Promise<Record<string, PublishResponse>>;
    publishSelfUpdate(envelope: NostrEvent, pending: PendingState): Promise<Record<string, PublishResponse>>;
    publishCommit(options: PublishCommitOptions): Promise<Record<string, PublishResponse>>;
}
