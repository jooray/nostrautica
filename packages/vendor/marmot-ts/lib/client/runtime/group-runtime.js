import { createAuditEmitter, errorDetail, } from "../../audit/index.js";
import { hasAck } from "../../utils/index.js";
/** Drives group publish effects through Nostr and confirms or rolls back state. */
export class GroupRuntime {
    welcomeDelivery;
    #getNetwork;
    #getRelays;
    #getGroupRef;
    #getGroupData;
    #confirmPublished;
    #publishFailed;
    #save;
    #log;
    #audit;
    constructor(options) {
        this.welcomeDelivery = options.welcomeDelivery;
        this.#getNetwork = options.getNetwork;
        this.#getRelays = options.getRelays;
        this.#getGroupRef = options.getGroupRef;
        this.#getGroupData = options.getGroupData;
        this.#confirmPublished = options.confirmPublished;
        this.#publishFailed = options.publishFailed;
        this.#save = options.save;
        this.#log = options.log;
        this.#audit = createAuditEmitter(options.audit && options.auditContext
            ? { ...options.auditContext, sink: options.audit }
            : undefined);
    }
    async publishEffects(effects) {
        const results = [];
        for (const work of effects.publish) {
            results.push(await this.#publishWorkResult(work));
        }
        return results;
    }
    async #publishWorkResult(work) {
        switch (work.kind) {
            case "applicationMessage":
                return {
                    work,
                    response: await this.publishApplication(work.envelope),
                    notifications: [],
                    persistence: { kind: "notRequired" },
                    welcomeDelivery: { kind: "notRequired" },
                    retryPublication: false,
                };
            case "proposal":
                return {
                    work,
                    ...(await this.#publishProposalResult(work.envelope, work.pending)),
                    welcomeDelivery: { kind: "notRequired" },
                };
            case "selfUpdate": {
                const result = await this.#publishSelfUpdateResult(work.envelope, work.pending);
                return {
                    work,
                    ...result,
                    welcomeDelivery: { kind: "notRequired" },
                };
            }
            case "groupEvolution": {
                const result = await this.#publishCommitResult({
                    envelope: work.envelope,
                    pending: work.pending,
                    actorPubkey: work.actorPubkey,
                    welcome: work.welcome,
                    welcomeRecipients: work.welcomeRecipients,
                });
                return { work, ...result };
            }
        }
    }
    async publishWork(work) {
        switch (work.kind) {
            case "applicationMessage":
                return this.publishApplication(work.envelope);
            case "proposal":
                return this.publishProposal(work.envelope, work.pending);
            case "selfUpdate":
                return this.publishSelfUpdate(work.envelope, work.pending);
            case "groupEvolution":
                return this.publishCommit({
                    envelope: work.envelope,
                    pending: work.pending,
                    actorPubkey: work.actorPubkey,
                    welcome: work.welcome,
                    welcomeRecipients: work.welcomeRecipients,
                });
        }
    }
    async publishApplication(envelope) {
        return this.#publishToGroupRelays(envelope, "Failed to publish application message");
    }
    async publishProposal(envelope, pending) {
        return (await this.#publishProposalResult(envelope, pending)).response;
    }
    async #publishProposalResult(envelope, pending) {
        let response;
        try {
            response = await this.#publishToGroupRelays(envelope, "Failed to publish proposal event");
        }
        catch (error) {
            this.#publishFailed(pending);
            throw error;
        }
        try {
            this.#confirmPublished(pending);
        }
        catch (error) {
            return {
                response,
                notifications: [],
                persistence: { kind: "failed", error: errorDetail(error) },
                retryPublication: false,
            };
        }
        const persistence = await this.#persistConfirmedState();
        return {
            response,
            notifications: [],
            persistence,
            retryPublication: false,
        };
    }
    async publishSelfUpdate(envelope, pending) {
        return (await this.#publishSelfUpdateResult(envelope, pending)).response;
    }
    async #publishSelfUpdateResult(envelope, pending) {
        // A selfUpdate is a commit and now stages through `PendingPublish`
        // (CR-09/WR-17), so a publish failure MUST roll the lifecycle back —
        // otherwise the engine is stuck and can never prepare another commit.
        let response;
        try {
            response = await this.#publishToGroupRelays(envelope, "Failed to publish commit event");
        }
        catch (err) {
            this.#publishFailed(pending);
            throw err;
        }
        let notifications;
        try {
            notifications = this.#confirmPublished(pending);
        }
        catch (error) {
            return {
                response,
                notifications: [],
                persistence: { kind: "failed", error: errorDetail(error) },
                retryPublication: false,
            };
        }
        const persistence = await this.#persistConfirmedState();
        return { response, notifications, persistence, retryPublication: false };
    }
    async publishCommit(options) {
        return (await this.#publishCommitResult(options)).response;
    }
    async #publishCommitResult(options) {
        let response;
        try {
            response = await this.#publishToGroupRelays(options.envelope, "Failed to publish commit");
        }
        catch (err) {
            this.#publishFailed(options.pending);
            throw err;
        }
        let notifications;
        try {
            notifications = this.#confirmPublished(options.pending);
        }
        catch (error) {
            return {
                response,
                notifications: [],
                persistence: { kind: "failed", error: errorDetail(error) },
                welcomeDelivery: { kind: "notRequired" },
                retryPublication: false,
            };
        }
        const persistence = await this.#persistConfirmedState();
        const innerWelcome = options.welcome?.welcome;
        let welcomeDelivery = {
            kind: "notRequired",
        };
        if (innerWelcome && options.welcomeRecipients?.length) {
            welcomeDelivery = await this.#deliverWelcomes(innerWelcome, options.actorPubkey, options.welcomeRecipients);
        }
        return {
            response,
            notifications,
            persistence,
            welcomeDelivery,
            retryPublication: false,
        };
    }
    async #persistConfirmedState() {
        try {
            await this.#save();
            return { kind: "succeeded" };
        }
        catch (error) {
            return { kind: "failed", error: errorDetail(error) };
        }
    }
    async #publishToGroupRelays(envelope, failurePrefix) {
        const relays = this.#getRelays();
        if (!relays)
            throw new Error("Group has no relays available to send messages.");
        this.#emitPublishAttempt(envelope, "group", relays);
        let response;
        try {
            response = await this.#getNetwork().publish(relays, envelope);
        }
        catch (error) {
            this.#emitPublishFailure(envelope, "group", relays, "adapter", error);
            throw error;
        }
        const acked = Object.entries(response)
            .filter(([, r]) => r.ok)
            .map(([url]) => url);
        this.#log?.("publish kind-%d eventId=%s relays=%o acked=%o", envelope.kind, envelope.id, relays, acked);
        if (!hasAck(response)) {
            const errors = Object.values(response)
                .filter((r) => !r.ok && r.message)
                .map((r) => r.message)
                .join("; ");
            this.#emitPublishOutcome(envelope, "group", response, false);
            this.#emitPublishFailure(envelope, "group", relays, "required_acks", errors || "no relay acknowledged");
            throw new Error(`${failurePrefix}: ${errors || "no relay acknowledged"}`);
        }
        this.#emitPublishOutcome(envelope, "group", response, true);
        return response;
    }
    #emitPublishAttempt(envelope, targetKind, relays) {
        this.#audit?.emit({
            type: "publish_attempt",
            msg_id: envelope.id,
            artifact_kind: artifactKindFromNostrEvent(envelope),
            target_kind: targetKind,
            transport: transportEnvelopeFromNostrEvent(envelope),
            relay_urls: relays,
            required_acks: 1,
        }, { groupRef: this.#groupRef() });
    }
    #emitPublishOutcome(envelope, targetKind, response, metRequiredAcks) {
        this.#audit?.emit({
            type: "publish_outcome",
            msg_id: envelope.id,
            artifact_kind: artifactKindFromNostrEvent(envelope),
            target_kind: targetKind,
            transport: transportEnvelopeFromNostrEvent(envelope),
            accepted_relay_urls: Object.keys(response).filter((url) => response[url]?.ok),
            failed_relays: Object.values(response)
                .filter((relay) => !relay.ok)
                .map((relay) => ({
                relay_url: relay.from,
                reason: relay.message ?? "publish_failed",
            })),
            required_acks: 1,
            met_required_acks: metRequiredAcks,
        }, { groupRef: this.#groupRef() });
    }
    #emitPublishFailure(envelope, targetKind, relays, stage, reason) {
        this.#audit?.emit({
            type: "publish_failure",
            msg_id: envelope.id,
            artifact_kind: artifactKindFromNostrEvent(envelope),
            stage,
            target_kind: targetKind,
            transport: transportEnvelopeFromNostrEvent(envelope),
            relay_urls: relays,
            reason: typeof reason === "string" ? reason : errorDetail(reason),
        }, { groupRef: this.#groupRef() });
    }
    #groupRef() {
        return this.#getGroupRef();
    }
    /**
     * Delivers a Welcome to each recipient via the shared, non-throwing
     * {@link NostrWelcomeDelivery.deliverMany} fanout (D-06/D-07) and reduces
     * the result into {@link WelcomeFanoutOutcome}. This method itself must
     * never throw: it runs after the commit has been confirmed and persisted,
     * so a Welcome failure must never reject the publish (`publishFailed` is
     * exclusive to pre-confirm relay failures — Phase 03.1-02).
     */
    async #deliverWelcomes(welcome, actorPubkey, recipients) {
        const groupData = this.#getGroupData();
        if (!groupData) {
            const message = "MarmotGroupData not found in ClientState.";
            return {
                kind: "attempted",
                outcomes: recipients.map((recipient) => ({
                    kind: "failed",
                    recipient,
                    error: message,
                })),
            };
        }
        this.#log?.("Sending Welcome messages to %d recipient(s)", recipients.length);
        try {
            const outcomes = await this.welcomeDelivery.deliverMany({
                welcome,
                author: actorPubkey,
                groupRelays: groupData.relays,
                recipients,
            });
            const failed = outcomes.filter((outcome) => outcome.kind === "failed");
            if (failed.length > 0) {
                this.#log?.("%d/%d Welcome(s) failed to deliver: %O", failed.length, recipients.length, failed.map((outcome) => `${outcome.recipient.pubkey.slice(0, 16)}...: ${outcome.error}`));
            }
            return { kind: "attempted", outcomes };
        }
        catch (error) {
            // deliverMany is contractually non-throwing, but this defensively
            // covers an unexpected throw so it can never reject the publish.
            const message = errorDetail(error);
            return {
                kind: "attempted",
                outcomes: recipients.map((recipient) => ({
                    kind: "failed",
                    recipient,
                    error: message,
                })),
            };
        }
    }
}
function artifactKindFromNostrEvent(event) {
    if (event.kind === 444)
        return "welcome";
    if (event.kind === 445)
        return "unknown";
    return "unknown";
}
function transportEnvelopeFromNostrEvent(event) {
    const groupTag = event.tags.find((tag) => tag[0] === "h")?.[1];
    return {
        transport: "nostr",
        wire_id: event.id,
        wire_kind: event.kind.toString(),
        wire_pubkey_hex: event.pubkey,
        transport_group_id: groupTag,
        nostr_event_id: event.id,
        nostr_kind: event.kind,
        nostr_pubkey_hex: event.pubkey,
    };
}
