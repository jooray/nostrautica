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
            results.push({ work, response: await this.publishWork(work) });
        }
        return results;
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
        const response = await this.#publishToGroupRelays(envelope, "Failed to publish proposal event");
        this.#confirmPublished(pending);
        await this.#save();
        return response;
    }
    async publishSelfUpdate(envelope, pending) {
        const response = await this.#publishToGroupRelays(envelope, "Failed to publish commit event");
        this.#confirmPublished(pending);
        await this.#save();
        return response;
    }
    async publishCommit(options) {
        let response;
        try {
            response = await this.#publishToGroupRelays(options.envelope, "Failed to publish commit");
        }
        catch (err) {
            this.#publishFailed(options.pending);
            throw err;
        }
        this.#confirmPublished(options.pending);
        await this.#save();
        const innerWelcome = options.welcome?.welcome;
        if (innerWelcome && options.welcomeRecipients?.length) {
            await this.#deliverWelcomes(innerWelcome, options.actorPubkey, options.welcomeRecipients);
        }
        return response;
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
    async #deliverWelcomes(welcome, actorPubkey, recipients) {
        const groupData = this.#getGroupData();
        if (!groupData)
            throw new Error("MarmotGroupData not found in ClientState.");
        this.#log?.("Sending Welcome messages to %d recipient(s)", recipients.length);
        const welcomeResults = await Promise.allSettled(recipients.map((recipient) => this.welcomeDelivery.deliver({
            welcome,
            author: actorPubkey,
            groupRelays: groupData.relays,
            recipient,
        })));
        const failureDetails = welcomeResults
            .map((result, i) => ({ result, recipient: recipients[i] }))
            .filter((item) => item.result.status === "rejected")
            .map((item) => {
            const msg = item.result.reason instanceof Error
                ? item.result.reason.message
                : String(item.result.reason);
            return `${item.recipient.pubkey.slice(0, 16)}...: ${msg}`;
        });
        if (failureDetails.length > 0) {
            this.#log?.("%d/%d Welcome(s) failed to deliver: %O", failureDetails.length, recipients.length, failureDetails);
            throw new Error(`Failed to deliver ${failureDetails.length}/${recipients.length} Welcome message(s): ${failureDetails.join("; ")}`);
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
//# sourceMappingURL=group-runtime.js.map