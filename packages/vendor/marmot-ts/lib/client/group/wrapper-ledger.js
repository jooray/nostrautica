import { bytesToHex } from "@noble/hashes/utils.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Durable, group-scoped record of verified transport wrappers handled terminally. */
export class TerminalWrapperLedger {
    store;
    groupId;
    constructor(store, groupId) {
        this.store = store;
        this.groupId = groupId;
    }
    #key(eventId) {
        return `${this.groupId}/ingest/wrapper/v1/${eventId}`;
    }
    async get(eventId, currentStateHash) {
        const bytes = await this.store.getItem(this.#key(eventId));
        if (!bytes)
            return undefined;
        try {
            const value = JSON.parse(decoder.decode(bytes));
            if (value.version === 1 &&
                (value.outcome === "accepted" ||
                    value.outcome === "stale" ||
                    value.outcome === "invalidated"))
                return value.outcome;
            const current = value;
            if (current.version === 2 && current.state === "terminal")
                return current.outcome;
            if (current.version === 3 && current.state === "terminal")
                return current.outcome;
            if (current.version === 3 &&
                current.state === "applied" &&
                currentStateHash === current.resultingStateHash &&
                current.resultingStateHash !== current.priorStateHash)
                return current.outcome;
        }
        catch {
            // Corrupt evidence is ignored; the verified wrapper remains processable.
        }
        return undefined;
    }
    /** Records the durable pre-apply side of the ingest transaction. */
    async begin(eventId, priorStateHash) {
        if (await this.get(eventId, priorStateHash))
            return;
        const existing = await this.store.getItem(this.#key(eventId));
        if (existing)
            return;
        const value = {
            version: 3,
            state: "prepared",
            priorStateHash,
        };
        await this.store.setItem(this.#key(eventId), encoder.encode(JSON.stringify(value)));
    }
    /** Binds recoverable application evidence to this wrapper's exact result. */
    async stageApplied(eventId, priorStateHash, resultingStateHash, outcome) {
        const value = {
            version: 3,
            state: "applied",
            priorStateHash,
            resultingStateHash,
            outcome,
        };
        await this.store.setItem(this.#key(eventId), encoder.encode(JSON.stringify(value)));
    }
    async record(eventId, outcome) {
        const value = { version: 3, state: "terminal", outcome };
        await this.store.setItem(this.#key(eventId), encoder.encode(JSON.stringify(value)));
    }
}
/** Durable observation verdicts for branch-selection withdrawal/re-adoption. */
export class ConvergenceEffectLedger {
    store;
    groupId;
    constructor(store, groupId) {
        this.store = store;
        this.groupId = groupId;
    }
    #key(digest) {
        return `${this.groupId}/ingest/effect/v1/${bytesToHex(digest)}`;
    }
    async #readKey(key) {
        const bytes = await this.store.getItem(key);
        if (!bytes)
            return undefined;
        try {
            const value = JSON.parse(decoder.decode(bytes));
            if (value.version === 1 &&
                (value.state === "withdrawn" || value.state === "active"))
                return value;
            if (value.version === 2 &&
                (value.state === "pending" || value.state === "observed") &&
                (value.direction === "withdrawal" || value.direction === "adoption") &&
                Array.isArray(value.notifications))
                return value;
        }
        catch {
            // Corrupt local evidence cannot establish an observation boundary.
        }
        return undefined;
    }
    async #read(digest) {
        return this.#readKey(this.#key(digest));
    }
    async #write(digest, value) {
        await this.store.setItem(this.#key(digest), encoder.encode(JSON.stringify(value)));
    }
    async prepareWithdrawal(digest, forkEpoch, notifications) {
        const existing = await this.#read(digest);
        if (existing?.version === 1 && existing.state === "withdrawn")
            return false;
        if (existing?.version === 2 && existing.direction === "withdrawal")
            return existing.state === "pending";
        await this.#write(digest, {
            version: 2,
            state: "pending",
            direction: "withdrawal",
            forkEpoch,
            notifications: notifications.map((notification) => ({
                ...notification,
                commitDigest: bytesToHex(notification.commitDigest),
            })),
        });
        return true;
    }
    async prepareAdoption(digest, notifications) {
        const existing = await this.#read(digest);
        const withdrawn = (existing?.version === 1 && existing.state === "withdrawn") ||
            (existing?.version === 2 &&
                existing.direction === "withdrawal" &&
                existing.state === "observed");
        if (!withdrawn) {
            if (existing?.version === 2 && existing.direction === "adoption")
                return existing.state === "pending";
            return false;
        }
        await this.#write(digest, {
            version: 2,
            state: "pending",
            direction: "adoption",
            notifications: notifications.map((notification) => ({
                ...notification,
                commitDigest: bytesToHex(notification.commitDigest),
            })),
        });
        return true;
    }
    async acknowledge(digest, direction) {
        const existing = await this.#read(digest);
        if (existing?.version !== 2 ||
            existing.direction !== direction ||
            existing.state !== "pending")
            return;
        await this.#write(digest, { ...existing, state: "observed" });
    }
    async pending() {
        const prefix = `${this.groupId}/ingest/effect/v1/`;
        const pending = [];
        for (const key of await this.store.keys()) {
            if (!key.startsWith(prefix))
                continue;
            const value = await this.#readKey(key);
            if (value?.version !== 2 || value.state !== "pending")
                continue;
            const digest = Uint8Array.from(key
                .slice(prefix.length)
                .match(/.{2}/g)
                ?.map((byte) => Number.parseInt(byte, 16)) ?? []);
            const notifications = value.notifications.map((notification) => ({
                ...notification,
                commitDigest: Uint8Array.from(notification.commitDigest
                    .match(/.{2}/g)
                    ?.map((byte) => Number.parseInt(byte, 16)) ?? []),
            }));
            pending.push(value.direction === "withdrawal"
                ? {
                    kind: "stateInvalidated",
                    commitDigest: digest,
                    forkEpoch: value.forkEpoch,
                    withdrawn: notifications,
                }
                : {
                    kind: "stateRevalidated",
                    commitDigest: digest,
                    effectId: digest,
                    notifications,
                });
        }
        return pending;
    }
}
