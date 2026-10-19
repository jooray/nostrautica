import { bytesToHex } from "@noble/hashes/utils.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const safeEpoch = (epoch) => Number.isSafeInteger(epoch) && epoch >= 0;
const outcomeValid = (outcome) => outcome === "accepted" || outcome === "stale" || outcome === "invalidated";
const exactOwnedKey = (key, prefix) => key.startsWith(prefix) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length));
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
            if (current.version === 2 &&
                current.state === "terminal" &&
                outcomeValid(current.outcome))
                return current.outcome;
            if (current.version === 3 &&
                current.state === "terminal" &&
                outcomeValid(current.outcome))
                return current.outcome;
            const attributed = value;
            if (attributed.version === 4 &&
                attributed.state === "terminal" &&
                outcomeValid(attributed.outcome) &&
                ((safeEpoch(attributed.sourceEpoch) &&
                    attributed.completedAtEpoch === undefined) ||
                    (safeEpoch(attributed.completedAtEpoch) &&
                        attributed.sourceEpoch === undefined)))
                return attributed.outcome;
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
    async record(eventId, outcome, coordinate) {
        if (!outcomeValid(outcome) ||
            (coordinate &&
                !((safeEpoch(coordinate.sourceEpoch) &&
                    coordinate.completedAtEpoch === undefined) ||
                    (safeEpoch(coordinate.completedAtEpoch) &&
                        coordinate.sourceEpoch === undefined))))
            throw new Error("Invalid wrapper retention coordinate");
        const value = coordinate
            ? { version: 4, state: "terminal", outcome, ...coordinate }
            : { version: 3, state: "terminal", outcome };
        await this.store.setItem(this.#key(eventId), encoder.encode(JSON.stringify(value)));
    }
    /** Unknown/prepared/applied evidence cannot authorize provenance release. */
    async hasUnfinished() {
        const prefix = `${this.groupId}/ingest/wrapper/v1/`;
        for (const key of await this.store.keys()) {
            if (!exactOwnedKey(key, prefix))
                continue;
            if (!(await this.get(key.slice(prefix.length))))
                return true;
        }
        return false;
    }
    /** Migrate legacy terminal rows locally, then retire strictly below the floor. */
    async compactRetained(floorEpoch, completedAtEpoch, pinnedIds = new Set()) {
        if (!safeEpoch(floorEpoch) || !safeEpoch(completedAtEpoch))
            throw new Error("Invalid wrapper retention epoch");
        const prefix = `${this.groupId}/ingest/wrapper/v1/`;
        for (const key of await this.store.keys()) {
            if (!exactOwnedKey(key, prefix))
                continue;
            const id = key.slice(prefix.length);
            const outcome = await this.get(id);
            if (!outcome)
                continue;
            const bytes = await this.store.getItem(key);
            if (!bytes)
                continue;
            const value = JSON.parse(decoder.decode(bytes));
            if (value.version !== 4) {
                await this.record(id, outcome, { completedAtEpoch });
                continue;
            }
            const epoch = value.sourceEpoch ?? value.completedAtEpoch;
            if (epoch < floorEpoch && !pinnedIds.has(id))
                await this.store.removeItem(key);
        }
    }
    /** Only completed wrapper evidence belongs to terminal cleanup. */
    async cleanupCompleted() {
        const prefix = `${this.groupId}/ingest/wrapper/v1/`;
        for (const key of await this.store.keys())
            if (key.startsWith(prefix) && (await this.get(key.slice(prefix.length))))
                await this.store.removeItem(key);
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
            if ((value.version === 2 || value.version === 3) &&
                (value.state === "pending" || value.state === "observed") &&
                (value.direction === "withdrawal" || value.direction === "adoption") &&
                Array.isArray(value.notifications) &&
                (value.forkEpoch === undefined || safeEpoch(value.forkEpoch)) &&
                (value.direction !== "withdrawal" || safeEpoch(value.forkEpoch)) &&
                (value.version !== 3 ||
                    (value.producingDigest === key.slice(key.lastIndexOf("/") + 1) &&
                        /^[a-f0-9]{64}$/.test(value.producingDigest))) &&
                (value.producingEpoch === undefined ||
                    safeEpoch(value.producingEpoch)) &&
                value.notifications.every((notification) => /^[a-f0-9]{64}$/.test(notification.commitDigest)))
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
        if (existing &&
            existing.version !== 1 &&
            existing.direction === "withdrawal")
            return existing.state === "pending";
        await this.#write(digest, {
            version: 3,
            producingDigest: bytesToHex(digest),
            producingEpoch: notifications.find((notification) => notification.kind === "epochAdvanced" &&
                bytesToHex(notification.commitDigest) === bytesToHex(digest))?.kind === "epochAdvanced"
                ? notifications.find((notification) => notification.kind === "epochAdvanced" &&
                    bytesToHex(notification.commitDigest) === bytesToHex(digest)).to
                : undefined,
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
            (existing &&
                existing.version !== 1 &&
                existing.direction === "withdrawal" &&
                existing.state === "observed");
        if (!withdrawn) {
            if (existing &&
                existing.version !== 1 &&
                existing.direction === "adoption")
                return existing.state === "pending";
            return false;
        }
        await this.#write(digest, {
            version: 3,
            producingDigest: bytesToHex(digest),
            producingEpoch: existing && existing.version !== 1
                ? existing.producingEpoch
                : undefined,
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
        if (!existing ||
            existing.version === 1 ||
            existing.direction !== direction ||
            existing.state !== "pending")
            return;
        await this.#write(digest, { ...existing, state: "observed" });
    }
    async pending() {
        const prefix = `${this.groupId}/ingest/effect/v1/`;
        const pending = [];
        for (const key of await this.store.keys()) {
            if (!exactOwnedKey(key, prefix))
                continue;
            const value = await this.#readKey(key);
            if (!value || value.version === 1 || value.state !== "pending")
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
    /** Completed effects retire only when no proposed selectable member names them. */
    async compactRetained(digests) {
        const prefix = `${this.groupId}/ingest/effect/v1/`;
        for (const key of await this.store.keys()) {
            if (!exactOwnedKey(key, prefix))
                continue;
            const value = await this.#readKey(key);
            if (!value || (value.version !== 1 && value.state === "pending"))
                continue;
            if (!digests.has(key.slice(prefix.length)))
                await this.store.removeItem(key);
        }
    }
    async hasOpaqueDependency() {
        const prefix = `${this.groupId}/ingest/effect/v1/`;
        for (const key of await this.store.keys())
            if (exactOwnedKey(key, prefix) && !(await this.#readKey(key)))
                return true;
        return false;
    }
}
