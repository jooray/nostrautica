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
// `proposeRemoveUser` is NOT in marmot-ts's export map (UPSTREAM U7) — deep-import
// it through the vendored package's `./lib/*` wildcard export.
import { proposeRemoveUser } from "@internet-privacy/marmot-ts/lib/client/group/proposals/remove-member.js";
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
  /** Whether `pubkey` already holds at least one leaf in the group. */
  isMember(mlsGroupIdHex: string, pubkey: string): Promise<boolean>;
  /** Add a candidate from their key package (Add commit + Welcome delivery). */
  invite(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void>;
  /** Remove every leaf of each pubkey (real MLS Remove → forward secrecy). */
  removePubkeys(mlsGroupIdHex: string, pubkeys: string[]): Promise<void>;
  /** Ingest kind-445 group traffic so the coordinator's state stays converged. */
  ingest(mlsGroupIdHex: string, events: AnyEvent[]): Promise<void>;
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
    const group = await this.client.groups.get(mlsGroupIdHex);
    return group.evaluateKeyPackage(keyPackageEvent as never).eligible;
  }

  async isMember(mlsGroupIdHex: string, pubkey: string): Promise<boolean> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    return getPubkeyLeafNodes(group.state, pubkey).length > 0;
  }

  async invite(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void> {
    await this.client.groups.invite(mlsGroupIdHex, keyPackageEvent as never);
  }

  async removePubkeys(mlsGroupIdHex: string, pubkeys: string[]): Promise<void> {
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
  }

  async ingest(mlsGroupIdHex: string, events: AnyEvent[]): Promise<void> {
    // Drive the async ingest generator to completion; commits advance the epoch.
    for await (const _ of this.client.groups.ingest(mlsGroupIdHex, events as never)) {
      void _;
    }
  }
}
