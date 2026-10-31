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
  createInviteIntent,
  PublicationUncertainError,
} from "@internet-privacy/marmot-ts/client";
import { encode, mlsMessageEncoder } from "@internet-privacy/marmot-ts/mls";
import {
  commitDigest,
  encryptedMediaBlossomDefaultV2,
  getCredentialPubkey,
  getKeyPackage,
  getEpoch,
  getGroupMemberPubkeys,
  getNostrGroupIdHex,
  getPubkeyLeafNodes,
  validateKeyPackageAccountIdentityProof,
} from "@internet-privacy/marmot-ts/core";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import { bytesToHex } from "@nostrautica/protocol";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Store } from "../store/db.js";
import {
  makeMarmotStores,
  purgeGroupState,
  expireStalePreparedWrappers,
  leafActivityStore,
  quarantinePendingPublication,
  type LeafActivityStore,
} from "./stores.js";
import { makeCoordinatorSigner } from "./signer.js";

const { proposeRemoveUser, proposeUpdateMetadata } = Proposals;

/**
 * The Blossom servers a new room's encrypted-media policy (0x800b) names — MDK's
 * defaults for new groups, which our marmot-ts fork used to add on its own.
 * marmot-ts 0.8.0 adds no policy unless asked, but a room without one would not
 * require 0x800b and White Noise members could not send media in it, so every
 * room still gets the policy every MDK-created group carries.
 */
export const NEW_ROOM_MEDIA_ENDPOINTS = [
  "https://blossom.divine.video",
  "https://blossom.ditto.pub",
  "https://cdn.hzrd149.com",
];

/**
 * Whether a stored group can still be run by this library generation.
 *
 * `current` — loads, and its GroupContext is the current account-identity-proof
 * profile (component 0x8009, which White Noise / MDK require). `unsupported` —
 * loads, but was created under the legacy 0xF2F1 proof (marmot-ts 0.6.0) or a
 * mixed profile: the library refuses every inbound event for it and it can never
 * hold an MDK member. `missing` — a group id with no stored state at all.
 * `unreadable` — state exists but did not load: a corrupt or inconsistent store,
 * a format change between generations, or a fault during the load itself. It says
 * nothing about the group's profile, so it is never by itself grounds to discard
 * the group (prod 2026-10-23, see retire.ts).
 */
export type GroupProfileStatus = "current" | "unsupported" | "missing" | "unreadable";

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

/** One inbound commit applied by {@link ChatMls.ingest} (audit R-5). */
export interface IngestedCommit {
  fromEpoch: number;
  toEpoch: number;
  /** The committing leaf's pubkey; undefined when the library did not record it. */
  committer?: string;
  added: string[];
  removed: string[];
}

/** What one {@link ChatMls.ingest} batch did (audit R-5, K-7). */
export interface IngestReport {
  epochBefore: number;
  epochAfter: number;
  /** Inbound commits applied, in order. Our own (self-echo) are not listed. */
  commits: IngestedCommit[];
  /** self_remove commits this client was elected to make for a departing peer. */
  autoCommits: { removed: string[]; published: boolean }[];
  /**
   * Commits for an epoch we had already left that are not on our chain:
   * `adopted` when fork resolution moved us onto their branch, otherwise kept out.
   */
  forks: { epoch: number; eventId: string; adopted: boolean }[];
  /** Rejected or unreadable events, one line each. */
  failures: string[];
  /** An inbound commit removed the coordinator itself. */
  removedSelf: boolean;
}

/** The parts of a marmot ingest result this module reads (the union is wide). */
type IngestResultView = {
  kind: string;
  reason?: string;
  event?: { id?: string };
  envelope?: { id?: string };
  message?: unknown;
  result?: { kind: string; newState?: unknown; senderLeafIndex?: number };
  pending?: { parentState?: unknown; newState?: unknown };
  errors?: unknown[];
  decryptFailure?: boolean;
};

type ClientStateView = {
  confirmationTag: Uint8Array;
  groupContext: { epoch: bigint };
  ratchetTree: unknown[];
  historicalReceiverData?: Map<bigint, { ratchetTree?: unknown[] }>;
};

type HistoryTreeView = {
  node(tag: string): { epoch: number; parentTag?: string; edge?: { commitDigest: Uint8Array; senderLeafIndex?: number } } | undefined;
};

function historyTreeOf(group: unknown): HistoryTreeView {
  return (group as { session: { historyTree: HistoryTreeView } }).session.historyTree;
}

function epochOf(state: unknown): number {
  return Number((state as ClientStateView).groupContext.epoch);
}

/** The kind-445 event id of a result: the session layer calls it `event`, the engine `envelope`. */
function eventIdOf(result: IngestResultView): string {
  return String(result.event?.id ?? result.envelope?.id ?? "?");
}

const WIREFORMAT_PUBLIC = 1; // wireformats.mls_public_message
const WIREFORMAT_PRIVATE = 2; // wireformats.mls_private_message
const CONTENT_COMMIT = 3; // contentTypes.commit
const SENDER_MEMBER = 1; // senderTypes.member
const NODE_LEAF = 1; // nodeTypes.leaf

/**
 * For a COMMIT: the epoch it was made in and, when the framing shows it, the
 * committing leaf. Marmot frames commits as MLS PublicMessages inside the
 * kind-445 encryption, so the sender is in clear there. Undefined for anything
 * that is not a commit.
 */
function commitInfo(message: unknown): { epoch: number; senderLeaf?: number } | undefined {
  type Content = { epoch: bigint; contentType: number; sender?: { senderType: number; leafIndex?: number } };
  const m = message as
    | { wireformat?: number; publicMessage?: { content?: Content }; privateMessage?: { epoch: bigint; contentType: number } }
    | undefined;
  if (m?.wireformat === WIREFORMAT_PUBLIC) {
    const c = m.publicMessage?.content;
    if (!c || c.contentType !== CONTENT_COMMIT) return undefined;
    const senderLeaf = c.sender?.senderType === SENDER_MEMBER ? c.sender.leafIndex : undefined;
    return { epoch: Number(c.epoch), senderLeaf };
  }
  if (m?.wireformat === WIREFORMAT_PRIVATE && m.privateMessage?.contentType === CONTENT_COMMIT) {
    return { epoch: Number(m.privateMessage.epoch) };
  }
  return undefined;
}

/** The epoch a PrivateMessage (an application message) was sent in. */
function privateEpochOf(message: unknown): number | undefined {
  const m = message as { wireformat?: number; privateMessage?: { epoch: bigint } } | undefined;
  return m?.wireformat === WIREFORMAT_PRIVATE && m.privateMessage ? Number(m.privateMessage.epoch) : undefined;
}

/** An application message's sender, from the tree of the epoch it was sent in. */
function senderOfApplication(state: unknown, leaf: number | undefined, msgEpoch: number): string | undefined {
  if (leaf === undefined) return undefined;
  const s = state as ClientStateView;
  const tree = msgEpoch < epochOf(s) ? s.historicalReceiverData?.get?.(BigInt(msgEpoch))?.ratchetTree : s.ratchetTree;
  return leafPubkey(tree, leaf);
}

/** The Nostr pubkey on leaf `leafIndex` of a ratchet tree, if it holds a valid one. */
function leafPubkey(tree: unknown[] | undefined, leafIndex: number): string | undefined {
  const node = tree?.[leafIndex * 2] as { nodeType?: number; leaf?: { credential: unknown } } | undefined;
  if (!node || node.nodeType !== NODE_LEAF || !node.leaf) return undefined;
  try {
    return getCredentialPubkey(node.leaf.credential as never);
  } catch {
    return undefined;
  }
}

/**
 * The pubkey on `leaf` in the tree the commit was made against (`parentTree`),
 * falling back to the resulting state's trees. Undefined when unknown.
 */
function committerOf(parentTree: unknown[] | undefined, state: unknown, leaf: number | undefined, fromEpoch: number): string | undefined {
  if (leaf === undefined) return undefined;
  try {
    const s = state as ClientStateView;
    return (
      leafPubkey(parentTree, leaf) ??
      leafPubkey(s.historicalReceiverData?.get?.(BigInt(fromEpoch))?.ratchetTree, leaf) ??
      leafPubkey(s.ratchetTree, leaf)
    );
  } catch {
    return undefined;
  }
}

/**
 * The commit digests on the path from the group's current state back to the
 * history tree's root, and the root's epoch. Undefined when the tip is not in the
 * tree, in which case nothing can be called a fork.
 */
function canonicalChain(group: unknown): { digests: Set<string>; rootEpoch: number } | undefined {
  const tree = historyTreeOf(group);
  let node = tree.node(bytesToHex((group as { state: ClientStateView }).state.confirmationTag));
  if (!node) return undefined;
  const digests = new Set<string>();
  let rootEpoch = node.epoch;
  for (let guard = 0; node && guard < 100_000; guard++) {
    rootEpoch = node.epoch;
    if (node.edge) digests.add(bytesToHex(node.edge.commitDigest));
    node = node.parentTag ? tree.node(node.parentTag) : undefined;
  }
  return { digests, rootEpoch };
}

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
  /**
   * When `pubkey`'s leaf last sent a message or made a commit that the
   * coordinator ingested (audit K-1): how long ago, in which epoch, and the
   * group's epoch now. Undefined when there is no record.
   */
  lastActivity?(
    mlsGroupIdHex: string,
    pubkey: string,
  ): Promise<{ ageMs: number; epoch: number; currentEpoch: number } | undefined>;
  /** Add a candidate from their key package (Add commit + Welcome delivery). */
  invite(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void>;
  /** Remove every leaf of each pubkey (real MLS Remove → forward secrecy). */
  removePubkeys(mlsGroupIdHex: string, pubkeys: string[]): Promise<void>;
  /**
   * Replace the key package author's stale leaf (or leaves) with a fresh one from
   * `keyPackageEvent`, in ONE commit carrying the Removes and the Add, plus the
   * Welcome for the Add (audit K-1 point 3). Optional: without it the admin
   * falls back to {@link removePubkeys} then {@link invite}, two commits.
   */
  reenrol?(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void>;
  /**
   * Ingest kind-445 group traffic so the coordinator's state stays converged.
   * Says what was applied ({@link IngestReport}); a fake may return nothing.
   */
  ingest(mlsGroupIdHex: string, events: AnyEvent[]): Promise<IngestReport | void>;
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

/** One leaf's last sign of life (audit K-1): wall-clock ms, and the epoch it was in. */
type LeafActivity = { at: number; epoch: number };
/** Activity older than this is dropped when the map is next written. */
const LEAF_ACTIVITY_RETAIN_MS = 24 * 60 * 60 * 1000;
/** A leaf's activity is re-persisted at most this often unless its epoch moves. */
const LEAF_ACTIVITY_PERSIST_EVERY_MS = 60_000;

/**
 * The errors marmot-ts throws when a retained pending-publication record will
 * not restore (`pending-publication.js` `read()`, and the engine's
 * `restorePendingPublication`).
 */
const PENDING_PUBLICATION_FAILURE =
  /pending publication|pending welcome|publication acknowledgement|pending commit recovery/i;

/** How often every group's retained, unacknowledged commit is re-sent (audit K-7). */
export const PENDING_PUBLICATION_SWEEP_MS = 60_000;
/** At most one "still not acknowledged" line per group per this long. */
const RETRY_FAILURE_LOG_EVERY_MS = 10 * 60_000;

/** An error and its causes, outermost first, as one log-ready string. */
export function causeChain(e: unknown, depth = 4): string {
  const chain: string[] = [];
  for (let c: unknown = e; c && chain.length < depth; c = c instanceof Error ? c.cause : undefined)
    chain.push(c instanceof Error ? c.message : String(c));
  return chain.join(" <- ");
}

/** How often one group's unsettled ingest evidence is swept (audit R-44). */
const INGEST_SWEEP_EVERY_MS = 10 * 60 * 1000;

/** marmot_kv row holding the coordinator's own KeyPackage slot id. */
const SLOT_NAMESPACE = "client_meta";
const SLOT_KEY = "key_package_slot";

/**
 * The coordinator's 30443 slot id: 32 random bytes as lowercase hex, generated
 * once and persisted. marmot-ts 0.7.0 refuses any other `d` — a `MarmotClient`
 * built with a label like the old `nostrautica-coordinator` throws in its
 * constructor — and the spec forbids deriving the slot from the account key.
 * The coordinator founds groups and never publishes a KeyPackage, so the slot
 * only has to be valid and stable, not announced anywhere.
 */
export function coordinatorKeyPackageSlot(store: Store): string {
  const existing = store.marmotKvGet(SLOT_NAMESPACE, SLOT_KEY);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const slot = bytesToHex(generateSecretKey());
  store.marmotKvSet(SLOT_NAMESPACE, SLOT_KEY, slot);
  return slot;
}

/** Build a real `MarmotClient`-backed {@link ChatMls} off the coordinator key. */
export function createMarmotClientMls(deps: {
  store: Store;
  coordSk: Uint8Array;
  network: NostrNetworkInterface;
  /** Stable 64-hex slot for the coordinator's own 30443 key packages. */
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
    clientId: deps.clientId ?? coordinatorKeyPackageSlot(deps.store),
  });
  return {
    mls: new MarmotClientMls(
      client,
      getPublicKey(deps.coordSk),
      (id) => purgeGroupState(deps.store, id),
      (id) => expireStalePreparedWrappers(deps.store, id, Date.now()),
      leafActivityStore(deps.store),
      Date.now,
      (id) => quarantinePendingPublication(deps.store, id, Date.now()),
    ),
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
    /** Age out ingest evidence that will never settle (audit R-44); returns rows removed. */
    private readonly sweepIngestEvidence?: (mlsGroupIdHex: string) => number,
    /** Durable home of {@link lastActivity}'s per-group map (see {@link LeafActivityStore}). */
    private readonly activityStore?: LeafActivityStore,
    private readonly now: () => number = Date.now,
    /**
     * Move a group's retained pending-publication record aside; returns where
     * the backup went, or undefined when there was none (see {@link loadGroup}).
     */
    private readonly quarantinePendingPublication?: (mlsGroupIdHex: string) => string | undefined,
  ) {}

  /** Per group: pubkey → when, and in which epoch, its leaf last sent or committed. */
  private readonly activity = new Map<string, Map<string, LeafActivity>>();

  private activityOf(mlsGroupIdHex: string): Map<string, LeafActivity> {
    let map = this.activity.get(mlsGroupIdHex);
    if (map) return map;
    map = new Map();
    try {
      const raw = this.activityStore?.get(mlsGroupIdHex);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, LeafActivity>)) map.set(k, v);
    } catch {
      // Unreadable: start empty. The window below simply has no evidence yet.
    }
    this.activity.set(mlsGroupIdHex, map);
    return map;
  }

  private saveActivity(mlsGroupIdHex: string): void {
    const map = this.activity.get(mlsGroupIdHex);
    if (!map || !this.activityStore) return;
    const cutoff = this.now() - LEAF_ACTIVITY_RETAIN_MS;
    for (const [k, v] of map) if (v.at < cutoff) map.delete(k);
    try {
      this.activityStore.set(mlsGroupIdHex, JSON.stringify(Object.fromEntries(map)));
    } catch (e) {
      console.warn(`[chat] could not persist leaf activity for group ${mlsGroupIdHex.slice(0, 12)}…: ${causeChain(e)}`);
    }
  }

  /** Record that `pubkey`'s leaf was active in `epoch`; true when worth persisting. */
  private noteActivity(map: Map<string, LeafActivity>, pubkey: string, epoch: number): boolean {
    const at = this.now();
    const prev = map.get(pubkey);
    map.set(pubkey, { at, epoch: Math.max(epoch, prev?.epoch ?? 0) });
    // Persisting every message would be a SQLite write per message; the decision
    // this feeds works in tens of minutes, so a minute of staleness is nothing.
    return !prev || epoch > prev.epoch || at - prev.at >= LEAF_ACTIVITY_PERSIST_EVERY_MS;
  }

  /**
   * When `pubkey`'s leaf last showed it is alive (audit K-1): an application
   * message it sent, or a commit it made, as seen by this coordinator's ingest.
   * Undefined when nothing is on record. A device that really lost its MLS state
   * cannot produce either from that leaf.
   */
  async lastActivity(
    mlsGroupIdHex: string,
    pubkey: string,
  ): Promise<{ ageMs: number; epoch: number; currentEpoch: number } | undefined> {
    const seen = this.activityOf(mlsGroupIdHex).get(pubkey);
    if (!seen) return undefined;
    const group = await this.client.groups.get(mlsGroupIdHex);
    return { ageMs: Math.max(0, this.now() - seen.at), epoch: seen.epoch, currentEpoch: epochOf(group.state) };
  }

  /** Drop the activity of leaves that are gone, so a re-added device starts clean. */
  private forgetActivity(mlsGroupIdHex: string, pubkeys: string[]): void {
    const map = this.activityOf(mlsGroupIdHex);
    let changed = false;
    for (const p of pubkeys) changed = map.delete(p) || changed;
    if (changed) this.saveActivity(mlsGroupIdHex);
  }

  /** When each group's ingest evidence was last swept (see {@link ingest}). */
  private readonly lastIngestSweep = new Map<string, number>();

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
  async loadAll(opts: { retrySweepEveryMs?: number } = {}): Promise<void> {
    for (const id of await this.storedGroupIds()) {
      const loaded = await this.loadGroup(id).then(
        () => true,
        () => false,
      );
      // A commit left unacknowledged by the previous run goes out first (K-7).
      if (loaded) await this.serialize(id, () => this.retryPending(id));
    }
    // The daemon's own 60 s timer (coordinator.ts) drives retryPendingPublications;
    // a caller without one can ask for this class's sweep instead.
    if (opts.retrySweepEveryMs) this.startRetrySweep(opts.retrySweepEveryMs);
  }

  /**
   * Re-send every group's retained, unacknowledged commit (audit K-7). Each group
   * under its own lock, like every other state change. Never throws.
   *
   * A commit whose publish was uncertain (a relay may hold it, none acked) is
   * kept by marmot-ts as exact bytes, and the group accepts no new commit until
   * those bytes are acknowledged. The next outbound intent re-sends them, but a
   * quiet room may not have one for hours, and while the record is pending
   * inbound traffic is held rather than applied. This sweep is what moves such a
   * group on. A no-op for a group with nothing retained.
   */
  async retryPendingPublications(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.storedGroupIds();
    } catch {
      return;
    }
    for (const id of ids) await this.serialize(id, () => this.retryPending(id));
  }

  private retrySweep?: ReturnType<typeof setInterval>;

  /** Start the periodic {@link retryPendingPublications}; idempotent, never keeps the process alive. */
  startRetrySweep(everyMs = PENDING_PUBLICATION_SWEEP_MS): void {
    if (this.retrySweep || everyMs <= 0) return;
    this.retrySweep = setInterval(() => void this.retryPendingPublications(), everyMs);
    this.retrySweep.unref?.();
  }

  /** Stop background work (the retry sweep). */
  stop(): void {
    if (this.retrySweep) clearInterval(this.retrySweep);
    this.retrySweep = undefined;
  }

  /** When each group's retry failure was last logged, and how many were not since. */
  private readonly retryFailureLog = new Map<string, { at: number; suppressed: number }>();

  /**
   * Re-send one group's retained commit, if it has one. The caller holds the
   * group's lock. Never throws: a relay that still does not ack leaves the record
   * in place for the next attempt, which is the point.
   */
  private async retryPending(mlsGroupIdHex: string): Promise<void> {
    // A group that does not load has its failure reported where it is loaded
    // (groupProfile, ingest); calling it "not acknowledged" here would mislead.
    const group = await this.client.groups.get(mlsGroupIdHex).catch(() => undefined);
    if (!group) return;
    try {
      const results = await group.retryPendingPublication();
      if (results.length > 0) {
        this.retryFailureLog.delete(mlsGroupIdHex);
        console.log(
          `[chat] re-sent the retained commit for group ${mlsGroupIdHex.slice(0, 12)}…: a relay acked it, epoch ${getEpoch(group.state as never)}`,
        );
      }
    } catch (e) {
      // Only a publication that is still unacknowledged is news. A disbanded or
      // torn-down group refuses the call too, and has nothing to retry.
      if (!(e instanceof PublicationUncertainError) && !/publish|publication/i.test(causeChain(e))) return;
      const now = Date.now();
      const last = this.retryFailureLog.get(mlsGroupIdHex);
      if (last && now - last.at < RETRY_FAILURE_LOG_EVERY_MS) {
        last.suppressed++;
        return;
      }
      const more = last?.suppressed ? ` (${last.suppressed} more since the last report)` : "";
      this.retryFailureLog.set(mlsGroupIdHex, { at: now, suppressed: 0 });
      console.warn(
        `[chat] retained commit for group ${mlsGroupIdHex.slice(0, 12)}… still not acknowledged${more}: ${causeChain(e)}`,
      );
    }
  }

  async storedGroupIds(): Promise<string[]> {
    const ids = await this.client.groups.listIds();
    return ids.map((id) => Array.from(id, (b) => b.toString(16).padStart(2, "0")).join(""));
  }

  /**
   * `groups.get`, with one recovery (audit K-8): marmot-ts 0.8.0 refuses to load a
   * group whose retained pending-publication record is malformed, or whose
   * parent no longer matches the canonical state, and on the coordinator such a
   * group then stays `unreadable` (kept, but dead) for good. That record is only
   * the bytes of a commit no relay acknowledged; dropping it can at worst lose a
   * commit nobody has, which the group then simply does not have. So: back the
   * record up, drop it, log loudly, and load once more.
   */
  private async loadGroup(mlsGroupIdHex: string) {
    try {
      return await this.client.groups.get(mlsGroupIdHex);
    } catch (e) {
      const why = causeChain(e, 6);
      if (!PENDING_PUBLICATION_FAILURE.test(why) || !this.quarantinePendingPublication) throw e;
      const backup = this.quarantinePendingPublication(mlsGroupIdHex);
      if (!backup) throw e;
      console.warn(
        `[chat] !!! MLS group ${mlsGroupIdHex.slice(0, 12)}… did not load because of its retained pending-publication record (${why}) — backed it up to ${backup} and dropped it; loading again`,
      );
      return await this.client.groups.get(mlsGroupIdHex);
    }
  }

  async groupProfile(mlsGroupIdHex: string): Promise<GroupProfileStatus> {
    try {
      const group = await this.loadGroup(mlsGroupIdHex);
      return group.profileSupport.kind === "supported" ? "current" : "unsupported";
    } catch (e) {
      if (!(await this.client.groups.has(mlsGroupIdHex).catch(() => true))) return "missing";
      // The one place this error is seen: everything above it reduces it to a status.
      console.warn(`[chat] MLS group ${mlsGroupIdHex.slice(0, 12)}… did not load: ${causeChain(e)}`);
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
      this.activity.delete(mlsGroupIdHex);
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
      encryptedMedia: encryptedMediaBlossomDefaultV2(NEW_ROOM_MEDIA_ENDPOINTS),
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

  /**
   * Remove + Add in one commit (audit K-1 point 3). MLS applies a commit's
   * Removes before its Adds, so the resulting epoch holds exactly one leaf for
   * the device, the fresh one. Two commits (Remove, then a separate invite) put
   * two membership changes in front of every member, as two White Noise notices,
   * and left an epoch in which the device was out but not yet invited back: a
   * failure between them left it out for good, and a competing commit there
   * forked the room one epoch further.
   */
  async reenrol(mlsGroupIdHex: string, keyPackageEvent: AnyEvent): Promise<void> {
    const actorPubkey = this.selfPubkey;
    if (!actorPubkey) throw new Error("reenrol needs the coordinator pubkey");
    await this.serialize(mlsGroupIdHex, async () => {
      const group = await this.client.groups.get(mlsGroupIdHex);
      const removes =
        getPubkeyLeafNodes(group.state, keyPackageEvent.pubkey).length > 0
          ? await proposeRemoveUser(keyPackageEvent.pubkey)(group.session.proposalContext())
          : [];
      // The library's own invite intent (same 30443 trust-boundary checks and
      // Welcome recipient as `groups.invite`), with the Removes in front.
      const intent = createInviteIntent({ keyPackageEvent: keyPackageEvent as never, actorPubkey });
      if (intent.kind !== "commit") throw new Error(`unexpected invite intent kind ${intent.kind}`);
      await this.client.groups.send(mlsGroupIdHex, {
        ...intent,
        extraProposals: [...removes, ...(intent.extraProposals ?? [])],
      });
      this.forgetActivity(mlsGroupIdHex, [keyPackageEvent.pubkey]);
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
      this.forgetActivity(mlsGroupIdHex, pubkeys);
    });
  }

  async ingest(mlsGroupIdHex: string, events: AnyEvent[]): Promise<IngestReport> {
    return this.serialize(mlsGroupIdHex, async () => {
      // Bound the durable `prepared` wrapper rows unreadable 445s leave behind
      // (audit R-44), under the group lock and at most every INGEST_SWEEP_EVERY_MS:
      // the sweep decrypts each wrapper row to read its state.
      const now = Date.now();
      if (this.sweepIngestEvidence && now - (this.lastIngestSweep.get(mlsGroupIdHex) ?? 0) >= INGEST_SWEEP_EVERY_MS) {
        this.lastIngestSweep.set(mlsGroupIdHex, now);
        try {
          const removed = this.sweepIngestEvidence(mlsGroupIdHex);
          if (removed > 0) console.warn(`[chat] aged out ${removed} unsettled 445 wrapper row(s) for group ${mlsGroupIdHex.slice(0, 8)}`);
        } catch (e) {
          console.warn(`[chat] ingest evidence sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // A retained commit goes out before anything is applied (audit K-7): while
      // it is pending, inbound traffic is held, and a commit we already hold
      // bytes for must win over regenerating a different one.
      await this.retryPending(mlsGroupIdHex);
      return this.ingestAndReport(mlsGroupIdHex, events);
    });
  }

  /**
   * Drive marmot's ingest generator to completion and say what it did (audit
   * R-5). Every result used to be discarded, so a co-admin's Add or Remove, an
   * auto-committed self_remove, a rejected commit and a fork all left no trace.
   * The caller holds the group's lock.
   */
  private async ingestAndReport(mlsGroupIdHex: string, events: AnyEvent[]): Promise<IngestReport> {
    const group = await this.client.groups.get(mlsGroupIdHex);
    const epochBefore = epochOf(group.state);
    const report: IngestReport = {
      epochBefore,
      epochAfter: epochBefore,
      commits: [],
      autoCommits: [],
      forks: [],
      failures: [],
      removedSelf: false,
    };
    let epoch = epochBefore;
    let members = new Set(getGroupMemberPubkeys(group.state));
    /** The ratchet tree the next inbound commit was made against, for its committer. */
    let tree = (group.state as unknown as ClientStateView).ratchetTree;
    /** Past-epoch commits, judged against the canonical chain once the batch is in. */
    const pastCommits: { epoch: number; eventId: string; digest: string }[] = [];
    let pendingAuto: IngestReport["autoCommits"][number] | undefined;
    const activity = this.activityOf(mlsGroupIdHex);
    let activityDirty = false;

    for await (const r of this.client.groups.ingest(mlsGroupIdHex, events as never)) {
      const result = r as unknown as IngestResultView;
      switch (result.kind) {
        case "processed": {
          const processed = result.result;
          if (processed?.kind === "applicationMessage") {
            // Who sent it: the leaf index is authenticated by MLS, and resolved
            // in the tree of the epoch the message was sent in.
            const msgEpoch = privateEpochOf(result.message) ?? epoch;
            const sender = senderOfApplication(group.state, processed.senderLeafIndex, msgEpoch);
            if (sender) activityDirty = this.noteActivity(activity, sender, msgEpoch) || activityDirty;
            break;
          }
          if (processed?.kind !== "newState") break;
          const commit = commitInfo(result.message);
          const toEpoch = epochOf(processed.newState);
          if (commit === undefined && toEpoch === epoch) break; // a proposal
          const after = new Set(getGroupMemberPubkeys(processed.newState as never));
          const fromEpoch = commit?.epoch ?? epoch;
          if (fromEpoch < epochBefore) {
            // Applied a commit for an epoch we had already left: fork resolution
            // moved us onto a competing branch.
            report.forks.push({ epoch: fromEpoch, eventId: eventIdOf(result), adopted: true });
          }
          const committed: IngestedCommit = {
            fromEpoch,
            toEpoch,
            committer: committerOf(tree, processed.newState, commit?.senderLeaf, fromEpoch),
            added: [...after].filter((p) => !members.has(p)).sort(),
            removed: [...members].filter((p) => !after.has(p)).sort(),
          };
          report.commits.push(committed);
          for (const p of committed.removed) activityDirty = activity.delete(p) || activityDirty;
          if (committed.committer && after.has(committed.committer)) {
            activityDirty = this.noteActivity(activity, committed.committer, toEpoch) || activityDirty;
          }
          members = after;
          epoch = toEpoch;
          tree = (processed.newState as ClientStateView).ratchetTree;
          break;
        }
        case "skipped": {
          if (result.reason !== "past-epoch") break;
          const commit = commitInfo(result.message);
          if (commit === undefined || commit.epoch >= epochOf(group.state)) break;
          pastCommits.push({
            epoch: commit.epoch,
            eventId: eventIdOf(result),
            digest: bytesToHex(commitDigest(encode(mlsMessageEncoder, result.message as never))),
          });
          break;
        }
        case "autoCommit": {
          const before = new Set(getGroupMemberPubkeys(result.pending?.parentState as never));
          const after = new Set(getGroupMemberPubkeys(result.pending?.newState as never));
          pendingAuto = { removed: [...before].filter((p) => !after.has(p)).sort(), published: false };
          report.autoCommits.push(pendingAuto);
          break;
        }
        case "appliedNotifications": {
          // Follows an autoCommit that was published and applied.
          if (pendingAuto) pendingAuto.published = true;
          pendingAuto = undefined;
          members = new Set(getGroupMemberPubkeys(group.state));
          epoch = epochOf(group.state);
          tree = (group.state as unknown as ClientStateView).ratchetTree;
          break;
        }
        case "rejected":
          report.failures.push(`commit rejected: ${result.reason ?? "authorization"}`);
          break;
        case "unreadable":
          report.failures.push(
            `${result.decryptFailure ? "undecryptable" : "unprocessable"} 445 ${eventIdOf(result).slice(0, 8)}: ${causeChain(result.errors?.[0])}`,
          );
          break;
        case "removed":
          report.removedSelf = true;
          break;
      }
    }
    report.epochAfter = epochOf(group.state);
    if (activityDirty) this.saveActivity(mlsGroupIdHex);

    if (pastCommits.length) {
      // A relay re-delivering a commit we applied long ago (every resubscribe does
      // that, and the dedup memory does not survive a restart) is not a fork. A
      // commit for an epoch we left that is NOT on our chain is.
      const canonical = canonicalChain(group);
      for (const c of pastCommits) {
        if (!canonical || canonical.digests.has(c.digest) || c.epoch < canonical.rootEpoch) continue;
        report.forks.push({ epoch: c.epoch, eventId: c.eventId, adopted: false });
      }
    }
    return report;
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
      this.activity.delete(mlsGroupIdHex);
      this.activityStore?.delete(mlsGroupIdHex);
    });
  }
}
