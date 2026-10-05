/**
 * The MLS operations the admin bot needs, as a narrow port ({@link ChatMls}) plus
 * its real implementation over a marmot-ts `MarmotClient`
 * ({@link MarmotClientMls}).
 *
 * The port exists so {@link MarmotAdmin}'s decision logic (who to add on approve,
 * who to remove on revoke, dedupe, chat-off inertness) is unit-testable against a
 * fake, while the one file that actually talks to the alpha marmot-ts library —
 * with its known frictions (`proposeRemoveUser`'s array-action result must be
 * resolved and flattened by hand before commit) — is isolated here.
 */
import {
  MarmotClient,
  Proposals,
  createChatRumor,
  createApplicationMessageIntent,
} from "@internet-privacy/marmot-ts/client";
import {
  getKeyPackage,
  getNostrGroupIdHex,
  getPubkeyLeafNodes,
  validateKeyPackageAccountIdentityProof,
} from "@internet-privacy/marmot-ts/core";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import { getPublicKey } from "nostr-tools/pure";
import type { Store } from "../store/db.js";
import { makeMarmotStores, purgeGroupState } from "./stores.js";
import { makeCoordinatorSigner } from "./signer.js";

const { proposeRemoveUser, proposeUpdateMetadata } = Proposals;

/**
 * Whether a stored group can still be run by this library generation.
 *
 * `current` — loads, and its GroupContext is the current account-identity-proof
 * profile (component 0x8009, which White Noise / MDK require). `unsupported` —
 * loads, but was created under the legacy 0xF2F1 proof (marmot-ts 0.6.0) or a
 * mixed profile: the library refuses every inbound event for it and it can never
 * hold an MDK member. `unreadable` — the stored state does not even deserialize
 * (or is missing), which a format change between generations can also cause.
 */
export type GroupProfileStatus = "current" | "unsupported" | "unreadable";

/**
 * Whether a kind-30443 carries a CURRENT KeyPackage: one with a valid 0x8009
 * account identity proof. A KeyPackage from before the upgrade (legacy 0xF2F1
 * proof, published by an app that has not reloaded yet, or by an outdated
 * White Noise) can never join a current group, and is not the device's fault
 * either — it is simply stale, and the device replaces it the next time it runs
 * current code. Never throws.
 */
export function keyPackageProfile(event: AnyEvent): { current: boolean; reason?: string } {
  try {
    validateKeyPackageAccountIdentityProof(getKeyPackage(event as never));
    return { current: true };
  } catch (e) {
    const reason = (e as { reason?: string }).reason ?? (e instanceof Error ? e.message : String(e));
    return { current: false, reason };
  }
}

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
  /**
   * Eligibility WITH the library's reasons, for logging a refusal that can be
   * acted on — and with `alreadyMember` surfaced separately, because it is the one
   * "reason" that is not a refusal at all. See `tryAddKeyPackage`.
   */
  evaluateKeyPackage?(
    mlsGroupIdHex: string,
    keyPackageEvent: AnyEvent,
  ): Promise<{ eligible: boolean; reasons: string[]; alreadyMember: boolean; legacy?: boolean }>;
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
  /** The group's avatar URL (group.avatar-url.v1), "" when it has none. */
  getAvatar(mlsGroupIdHex: string): Promise<string>;
  /**
   * Set the group's avatar URL — "" clears it (the component's empty state). The
   * caller passes an already-normalized URL (see avatar.ts). A no-op when it is
   * already the group's avatar; returns whether a commit was made.
   */
  setAvatar(mlsGroupIdHex: string, url: string): Promise<boolean>;
  /**
   * Post one kind-9 chat message, authored by the coordinator, to a group. Used
   * only for the external-client link confirmation group (NIP §10.5), whose one
   * message carries the one-time code. Convergence-gated like any send.
   */
  sendText(mlsGroupIdHex: string, content: string): Promise<void>;
  /** Drop a group's local state for good (the confirmation group, after use). */
  destroyGroup(mlsGroupIdHex: string): Promise<void>;
  /** See {@link GroupProfileStatus}. Never throws. */
  groupProfile?(mlsGroupIdHex: string): Promise<GroupProfileStatus>;
  /**
   * Every group id this client holds local state for, including ones whose state
   * no longer loads — so retirement can find groups no `marmot_groups` row names
   * (a link-confirmation group left behind by a crash).
   */
  storedGroupIds?(): Promise<string[]>;
  /**
   * Drop a group's local state even when it cannot be loaded. Never publishes:
   * a retired group gets no leave/self-remove traffic, it simply stops existing
   * here. Idempotent.
   */
  retireGroup?(mlsGroupIdHex: string): Promise<void>;
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
    // Also signs the kind-450 account identity proof (0x8009) on every
    // KeyPackage and leaf this client creates.
    signer: makeCoordinatorSigner(deps.coordSk) as never,
    network: deps.network,
    groupStateStore: stores.groupStateStore,
    keyPackageStore: stores.keyPackageStore,
    inviteStore: stores.inviteStore,
    rewindStore: stores.rewindStore,
    // Durable lifecycle + ingest evidence and removal marker, so a restart does
    // not forget a terminal commit, a convergence effect, or a realized removal.
    lifecycleStore: stores.lifecycleStore,
    ingestStateStore: stores.ingestStateStore,
    removedMarkerStore: stores.removedMarkerStore,
    clientId: deps.clientId ?? "nostrautica-coordinator",
  });
  return {
    mls: new MarmotClientMls(client, getPublicKey(deps.coordSk), (id) => purgeGroupState(deps.store, id)),
    client,
  };
}

export class MarmotClientMls implements ChatMls {
  constructor(
    private readonly client: MarmotClient,
    /** The coordinator's pubkey: the author of the rumors {@link sendText} posts. */
    private readonly selfPubkey?: string,
    /** Raw removal of one group's persisted state, for state that will not load. */
    private readonly purgeStoredGroup?: (mlsGroupIdHex: string) => void,
  ) {}

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

  /**
   * Load persisted groups into memory (call once at startup, AFTER retirement).
   * Per group rather than the library's `loadAll`: that is a `Promise.all`, so one
   * state that fails to load would leave every other group unloaded too.
   */
  async loadAll(): Promise<void> {
    for (const id of await this.storedGroupIds()) {
      await this.client.groups.get(id).catch(() => undefined);
    }
  }

  async storedGroupIds(): Promise<string[]> {
    const ids = await this.client.groups.listIds();
    return ids.map((id) => Array.from(id, (b) => b.toString(16).padStart(2, "0")).join(""));
  }

  async groupProfile(mlsGroupIdHex: string): Promise<GroupProfileStatus> {
    try {
      const group = await this.client.groups.get(mlsGroupIdHex);
      return group.profileSupport.kind === "supported" ? "current" : "unsupported";
    } catch {
      return "unreadable";
    }
  }

  async retireGroup(mlsGroupIdHex: string): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      // The library's own teardown first (it also drops the cached instance and
      // purges history); a state that will not load cannot go through it, so the
      // raw purge below always runs too and catches whatever is left.
      if (await this.client.groups.has(mlsGroupIdHex).catch(() => false)) {
        await this.client.groups.destroy(mlsGroupIdHex).catch(() => undefined);
      }
      this.purgeStoredGroup?.(mlsGroupIdHex);
    });
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
  ): Promise<{ eligible: boolean; reasons: string[]; alreadyMember: boolean; legacy?: boolean }> {
    // Checked first and separately: a pre-upgrade KeyPackage is not "ineligible"
    // in the sense the caller reports to the device's owner (see keyPackageProfile).
    const profile = keyPackageProfile(keyPackageEvent);
    if (!profile.current) {
      return {
        eligible: false,
        reasons: [`not a current (0x8009) KeyPackage: ${profile.reason}`],
        alreadyMember: false,
        legacy: true,
      };
    }
    const group = await this.client.groups.get(mlsGroupIdHex);
    const result = group.evaluateKeyPackage(keyPackageEvent as never) as {
      eligible: boolean;
      reasons?: string[];
      alreadyMember?: boolean;
    };
    // The library computes `eligible: reasons.length === 0` and pushes
    // "already a member" as one of those reasons, so a member is ALWAYS
    // ineligible. Carrying the flag through separately is what lets the caller
    // tell "this key package is unusable" from "this device is already in, which
    // is the very thing we are here to repair."
    return {
      eligible: result.eligible,
      reasons: result.reasons ?? [],
      alreadyMember: result.alreadyMember ?? false,
    };
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
      // No admin-policy update here: the library's commit path already drops a
      // removed admin from the policy in the same commit (adding our own made it
      // "multiple AppDataUpdate operations for 0x8003").
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

  async getAvatar(mlsGroupIdHex: string): Promise<string> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    return group.groupData?.avatarUrl ?? "";
  }

  async setAvatar(mlsGroupIdHex: string, url: string): Promise<boolean> {
    return this.serialize(mlsGroupIdHex, async () => {
      const group = await this.client.groups.get(mlsGroupIdHex);
      // Compared in normalized form on both sides: the caller normalizes, and what
      // the group holds was normalized by whoever wrote it (decoders reject
      // anything else). A group that never had the component reads as "".
      if ((group.groupData?.avatarUrl ?? "") === url) return false;
      const ctx = group.session.proposalContext();
      const proposals = await proposeUpdateMetadata({ avatarUrl: url })(ctx);
      await this.client.groups.commit(mlsGroupIdHex, { extraProposals: proposals });
      return true;
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
      // Only keys that hold a member leaf can be admins: the resulting epoch of
      // any commit must not list an admin without a leaf (MDK admin-leaf
      // coupling), so a desired-but-not-yet-joined organizer device is promoted
      // later, after its Add lands. Listing it early made EVERY later commit
      // illegal ("N admin key(s) have no member leaf"), including invites.
      const want = [...new Set(adminPubkeys)].filter(
        (k) => getPubkeyLeafNodes(group.state, k).length > 0,
      );
      if (want.length === current.length && want.every((k) => current.includes(k))) return;
      const ctx = group.session.proposalContext();
      const proposals = await proposeUpdateMetadata({ adminPubkeys: want })(ctx);
      await this.client.groups.commit(mlsGroupIdHex, { extraProposals: proposals });
    });
  }

  async sendText(mlsGroupIdHex: string, content: string): Promise<void> {
    const author = this.selfPubkey;
    if (!author) throw new Error("sendText needs the coordinator pubkey");
    // Serialized with the group's commits: the message must be encrypted under the
    // epoch the preceding invite produced, not race it.
    await this.serialize(mlsGroupIdHex, async () => {
      const rumor = createChatRumor({ pubkey: author, content });
      await this.client.groups.send(mlsGroupIdHex, createApplicationMessageIntent(rumor));
    });
  }

  async destroyGroup(mlsGroupIdHex: string): Promise<void> {
    await this.serialize(mlsGroupIdHex, async () => {
      await this.client.groups.destroy(mlsGroupIdHex);
    });
  }
}
