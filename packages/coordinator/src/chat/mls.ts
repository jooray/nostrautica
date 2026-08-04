/**
 * The MLS operations the admin bot needs, as a narrow port ({@link ChatMls}) plus
 * its real implementation over a marmot-ts `MarmotClient`
 * ({@link MarmotClientMls}).
 *
 * The port exists so {@link MarmotAdmin}'s decision logic (who to add on approve,
 * who to remove on revoke, dedupe, chat-off inertness) is unit-testable against a
 * fake, while the one file that actually talks to the alpha marmot-ts library —
 * with its known frictions (the deep-imported `proposeRemoveUser`, whose
 * array-action result must be resolved and flattened by hand before commit) — is
 * isolated here.
 */
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import {
  getNostrGroupIdHex,
  getPubkeyLeafNodes,
} from "@internet-privacy/marmot-ts/core";
// `proposeRemoveUser`/`proposeUpdateMetadata` are NOT in marmot-ts's export map
// (UPSTREAM U7) — deep-import them through the vendored package's `./lib/*`
// wildcard export.
import { proposeRemoveUser } from "@internet-privacy/marmot-ts/lib/client/group/proposals/remove-member.js";
import { proposeUpdateMetadata } from "@internet-privacy/marmot-ts/lib/client/group/proposals/update-metadata.js";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import type { Store } from "../store/db.js";
import { makeMarmotStores } from "./stores.js";
import {
  makeCoordinatorSigner,
  makeCoordinatorProofSigner,
} from "./signer.js";

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; [k: string]: unknown };

/** The MLS admin operations {@link MarmotAdmin} drives. Group ids are hex strings. */
export interface ChatMls {
  /** Create one MLS group; returns its MLS + public routing ids (both hex). */
  createGroup(opts: {
    name: string;
    description: string;
    relays: string[];
    adminPubkeys?: string[];
  }): Promise<{ mlsGroupIdHex: string; nostrGroupIdHex: string }>;
  /** Whether a candidate's kind-30443 key package can be added to the group. */
  isEligible(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<boolean>;
  /** Eligibility WITH the library's reasons, for logging a refusal that can be acted on. */
  evaluateKeyPackage?(
    mlsGroupIdHex: string,
    keyPackageEvent: AnyEvent,
  ): Promise<{ eligible: boolean; reasons: string[] }>;
  /** Whether `pubkey` already holds at least one leaf in the group. */
  isMember(mlsGroupIdHex: string, pubkey: string): Promise<boolean>;
  /** Add a candidate from their key package (Add commit + Welcome delivery). */
  invite(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void>;
  /** Remove every leaf of each pubkey (real MLS Remove → forward secrecy). */
  removePubkeys(mlsGroupIdHex: string, pubkeys: string[]): Promise<void>;
  /** Ingest kind-445 group traffic so the coordinator's state stays converged. */
  ingest(mlsGroupIdHex: string, events: AnyEvent[]): Promise<void>;
  /** The group's current message-routing relays (marmot.transport.nostr.routing.v1). */
  getRelays(mlsGroupIdHex: string): Promise<string[]>;
  /**
   * Additively ensure every relay in `relays` is part of the group's routing
   * relays — a no-op if they're all already present. Never removes an existing
   * relay: this is a self-heal for groups created before a relay was added to
   * the app's defaults, not a way to narrow a group's reach.
   */
  ensureRelays(mlsGroupIdHex: string, relays: string[]): Promise<void>;
  /** The group's current admin pubkey set (admin-policy.v1). */
  getAdmins(mlsGroupIdHex: string): Promise<string[]>;
  /**
   * Replace the group's admin set with EXACTLY `adminPubkeys` (admin-policy.v1 is
   * re-encoded in full). A no-op when the set already matches. The caller is
   * responsible for including the coordinator's own key — dropping it would lock
   * the coordinator out of admin commits.
   */
  setAdmins(mlsGroupIdHex: string, adminPubkeys: string[]): Promise<void>;
}

/** Build a real `MarmotClient`-backed {@link ChatMls} off the coordinator key. */
export function createMarmotClientMls(deps: {
  store: Store;
  coordSk: Uint8Array;
  network: NostrNetworkInterface;
  /** Stable per-device slot for the coordinator's own 30443 key packages. */
  clientId?: string;
}): { mls: MarmotClientMls; client: MarmotClient } {
  const stores = makeMarmotStores(deps.store);
  const client = new MarmotClient({
    signer: makeCoordinatorSigner(deps.coordSk) as never,
    accountProofSigner: makeCoordinatorProofSigner(deps.coordSk),
    network: deps.network,
    groupStateStore: stores.groupStateStore,
    keyPackageStore: stores.keyPackageStore,
    inviteStore: stores.inviteStore,
    rewindStore: stores.rewindStore,
    clientId: deps.clientId ?? "nostrautica-coordinator",
  });
  return { mls: new MarmotClientMls(client), client };
}

export class MarmotClientMls implements ChatMls {
  constructor(private readonly client: MarmotClient) {}

  /**
   * Per-group serialization of every STATE-MUTATING MLS op (invite / remove /
   * ingest). Each builds a commit — or advances the ratchet — from the group's
   * CURRENT epoch, so two running concurrently both fork off the same epoch: the
   * classic MLS concurrent-commit hazard. Without this, approving two attendees
   * back-to-back (their two `invite`s racing), or an `invite` racing the live
   * kind-445 `ingest`, committed only one and silently dropped the other's Add —
   * that member's Welcome was for a dead branch, so they sat on "Setting up…"
   * forever and never saw messages. Reads (isMember/isEligible) don't need it.
   */
  private readonly chains = new Map<string, Promise<unknown>>();
  private serialize<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(groupId) ?? Promise.resolve()).then(fn, fn);
    // Tail swallows settlement so one op's rejection can't break the next; the
    // caller still awaits `run` for the real result/error.
    const tail = run.then(
      () => {},
      () => {},
    );
    this.chains.set(groupId, tail);
    void tail.finally(() => {
      if (this.chains.get(groupId) === tail) this.chains.delete(groupId);
    });
    return run;
  }

  /** Load persisted groups into memory (call once at startup). */
  async loadAll(): Promise<void> {
    await this.client.groups.loadAll();
  }

  async createGroup(opts: {
    name: string;
    description: string;
    relays: string[];
    adminPubkeys?: string[];
  }): Promise<{ mlsGroupIdHex: string; nostrGroupIdHex: string }> {
    const group = await this.client.groups.create(opts.name, {
      description: opts.description,
      relays: opts.relays,
      ...(opts.adminPubkeys?.length ? { adminPubkeys: opts.adminPubkeys } : {}),
    });
    return {
      mlsGroupIdHex: group.idStr,
      nostrGroupIdHex: getNostrGroupIdHex(group.state),
    };
  }

  async isEligible(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<boolean> {
    return (await this.evaluateKeyPackage(mlsGroupIdHex, keyPackageEvent)).eligible;
  }

  /**
   * Eligibility plus WHY. The library computes a list of reasons ("already a
   * member", a ciphersuite mismatch, a missing required extension) and the old
   * boolean threw them away, so a refused device produced one unactionable log
   * line. During the 2026-08-04 chat incident that was the difference between
   * seeing the problem and guessing at it.
   */
  async evaluateKeyPackage(
    mlsGroupIdHex: string,
    keyPackageEvent: AnyEvent,
  ): Promise<{ eligible: boolean; reasons: string[] }> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    const result = group.evaluateKeyPackage(keyPackageEvent as never) as {
      eligible: boolean;
      reasons?: string[];
    };
    return { eligible: result.eligible, reasons: result.reasons ?? [] };
  }

  async isMember(mlsGroupIdHex: string, pubkey: string): Promise<boolean> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    return getPubkeyLeafNodes(group.state, pubkey).length > 0;
  }

  async invite(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      // Re-check membership INSIDE the lock: a concurrent invite for this same
      // pubkey (approval syncMember + the 30443 watcher both firing) may have
      // added it while we waited our turn — adding twice would spend a second
      // leaf and epoch for nothing.
      if (getPubkeyLeafNodes((await this.client.groups.get(mlsGroupIdHex)).state, keyPackageEvent.pubkey).length > 0) return;
      await this.client.groups.invite(mlsGroupIdHex, keyPackageEvent as never);
    });
  }

  async removePubkeys(mlsGroupIdHex: string, pubkeys: string[]): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      const group = await this.client.groups.get(mlsGroupIdHex);
      // Resolve each pubkey's remove-proposals against the live group context and
      // flatten into one commit (UPSTREAM U7: proposeRemoveUser is an array-action
      // that does not fit commit's single-proposal slot, so we resolve it by hand).
      const ctx = group.session.proposalContext();
      const extraProposals = [];
      for (const pk of pubkeys) {
        if (getPubkeyLeafNodes(group.state, pk).length === 0) continue; // no leaves → skip
        const removes = await proposeRemoveUser(pk)(ctx);
        extraProposals.push(...removes);
      }
      if (extraProposals.length === 0) return;
      await this.client.groups.commit(mlsGroupIdHex, { extraProposals });
    });
  }

  async ingest(mlsGroupIdHex: string, events: AnyEvent[]): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      // Drive the async ingest generator to completion; commits advance the epoch.
      for await (const _ of this.client.groups.ingest(mlsGroupIdHex, events as never)) {
        void _;
      }
    });
  }

  async getRelays(mlsGroupIdHex: string): Promise<string[]> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    return group.relays ?? [];
  }

  async ensureRelays(mlsGroupIdHex: string, relays: string[]): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      const group = await this.client.groups.get(mlsGroupIdHex);
      const current = group.relays ?? [];
      // Full-replacement semantics (proposeUpdateMetadata re-encodes the whole
      // routing component), so the new list must be current ∪ relays, not just
      // the new ones — otherwise this would silently drop the group's existing
      // relays. De-dupe against BOTH current and within `relays` itself.
      const have = new Set(current);
      const union = [...current];
      for (const r of relays) {
        if (have.has(r)) continue;
        have.add(r);
        union.push(r);
      }
      if (union.length === current.length) return; // already routes to every relay we want
      const ctx = group.session.proposalContext();
      const proposals = await proposeUpdateMetadata({ relays: union })(ctx);
      await this.client.groups.commit(mlsGroupIdHex, { extraProposals: proposals });
    });
  }

  async getAdmins(mlsGroupIdHex: string): Promise<string[]> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    return group.groupData?.adminPubkeys ?? [];
  }

  async setAdmins(mlsGroupIdHex: string, adminPubkeys: string[]): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      const group = await this.client.groups.get(mlsGroupIdHex);
      const current = group.groupData?.adminPubkeys ?? [];
      // admin-policy.v1 is a full-replacement component (proposeUpdateMetadata
      // re-encodes it whole), so `adminPubkeys` must already be the COMPLETE
      // desired set including the coordinator. No-op when it's unchanged
      // (order-insensitive) so a re-sync doesn't spend an epoch for nothing.
      const want = [...new Set(adminPubkeys)];
      if (want.length === current.length && want.every((k) => current.includes(k))) return;
      const ctx = group.session.proposalContext();
      const proposals = await proposeUpdateMetadata({ adminPubkeys: want })(ctx);
      await this.client.groups.commit(mlsGroupIdHex, { extraProposals: proposals });
    });
  }
}
