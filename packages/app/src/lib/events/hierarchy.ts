/**
 * Space hierarchy, client side (PROTOCOL-NIP.md §15): a community (31612) and the
 * dated events (31923) that belong to it.
 *
 * Membership flows UP only. This module is the organizer half and the pure rules:
 *
 *  - linking and unlinking (two E_id-signed 31600 republishes, one per side),
 *  - the membership proof an organizer client attaches to a 21602 grant,
 *  - listing a community's children, upcoming first,
 *  - verifying a `member_of` claim on a join request (manual-approval mode).
 *
 * The attendee half (consent, auto-join) lives in community-join.ts.
 *
 * Nothing here imports organizer.ts or attendee.ts: both of them import this.
 */
import { finalizeEvent } from "nostr-tools/pure";
import {
  KIND_EVENT_CONFIG,
  buildEventConfig,
  configForSpace,
  coordinateToNaddr,
  hexToBytes,
  isCommunityCoordinate,
  isLinked,
  makeMembershipProof,
  membershipAuthorities,
  parseCoordinate,
  parseEventConfig,
  pickLatest,
  verifyMembershipProof,
  type EventConfig,
  type MembershipProof,
} from "@nostrautica/protocol";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyAddressed } from "$lib/nostr/verify.js";
import { publishMonotonic, publishWatermark, eventAddress } from "$lib/nostr/monotonic.js";
import { hasPendingPublishFor } from "$lib/nostr/publish-queue.js";
import { DEFAULT_RELAYS, unionRelays } from "$lib/nostr/relays.js";
import { loadEventKeys, listEventKeys } from "./keystore.js";
import {
  cacheEventContext,
  cachedEventContext,
  eventRelayHints,
  loadEventContext,
  type EventContext,
} from "./event-context.js";

// ── Pure rules ───────────────────────────────────────────────────────────────

/** What a client should do about the community a child event's grant offered. */
export type CommunityJoinDecision = "join" | "offer" | "none";

/**
 * The rules of §15.5, in one place so the UI and the auto-join cannot drift.
 *
 *  - No proof, nothing to do.
 *  - Already a member of, or already waiting on, the community: nothing to do.
 *  - The person said yes at the join form: join now. This is the ONLY path that
 *    sends anything without a tap.
 *  - The person said no: leave them alone, never nag.
 *  - Never asked (joined before the feature, or a re-issued grant): offer it as a
 *    one-tap card, unless they already answered "not now".
 */
export function decideCommunityJoin(s: {
  hasProof: boolean;
  consent: boolean | undefined;
  dismissed?: boolean;
  isMember: boolean;
  isPending: boolean;
}): CommunityJoinDecision {
  if (!s.hasProof || s.isMember || s.isPending) return "none";
  if (s.consent === true) return "join";
  if (s.consent === false) return "none";
  return s.dismissed ? "none" : "offer";
}

/** A child event as a community lists it. `start` is unix seconds. */
export interface ChildSummary {
  coordinate: string;
  naddr: string;
  title: string;
  start?: number;
  icon?: string;
}

/**
 * Upcoming first (soonest first), then past (most recent first). An event with
 * no start sorts after the upcoming ones and before the past: it is not known to
 * be over. Ties break on title, then coordinate, so the order is deterministic.
 */
export function sortChildren<T extends { start?: number; title: string; coordinate: string }>(
  list: readonly T[],
  nowSec: number = Math.floor(Date.now() / 1000),
): T[] {
  const rank = (c: T) => (c.start === undefined ? 1 : c.start >= nowSec ? 0 : 2);
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0 && a.start !== b.start) return a.start! - b.start!;
    if (ra === 2 && a.start !== b.start) return b.start! - a.start!;
    return a.title.localeCompare(b.title) || a.coordinate.localeCompare(b.coordinate);
  });
}

/** A `member_of` claim as read off a join request. */
export interface MemberOfClaim {
  child: string;
  by: string;
  sig: string;
}

/**
 * Accept a `member_of` claim iff (§15.4) the two NEWEST configs link the spaces,
 * `by` is an authority of the child, and the signature verifies. `childCfg` is
 * undefined when the child's config could not be fetched: not verifiable.
 */
export function verifyMemberOfClaim(
  parent: string,
  parentCfg: Pick<EventConfig, "children">,
  claim: MemberOfClaim,
  childCfg: Pick<EventConfig, "parent" | "coordinator"> | undefined,
  attendee: string,
): boolean {
  if (!childCfg) return false;
  if (!isLinked(parent, parentCfg, claim.child, childCfg)) return false;
  return verifyMembershipProof(
    claim,
    parent,
    claim.child,
    attendee,
    membershipAuthorities(claim.child, childCfg),
  );
}

// ── Config reads ─────────────────────────────────────────────────────────────

/**
 * The newest signed 31600 for a coordinate. `fresh` reads relays only, for the
 * read-modify-write paths: a republish built on a cached config would silently
 * drop whatever another device changed since.
 */
export async function fetchNewestConfig(
  coordinate: string,
  relays: string[] = [],
  opts: { fresh?: boolean } = {},
): Promise<EventConfig | undefined> {
  return (await fetchNewestSignedConfig(coordinate, relays, opts))?.config;
}

/**
 * {@link fetchNewestConfig} plus the winning event's `created_at`, for the
 * writers that must not re-sign something older than what they already know
 * about (audit R-29, see {@link assertConfigNotStale}).
 */
export async function fetchNewestSignedConfig(
  coordinate: string,
  relays: string[] = [],
  opts: { fresh?: boolean } = {},
): Promise<{ config: EventConfig; createdAt: number } | undefined> {
  let coord;
  try {
    coord = parseCoordinate(coordinate);
  } catch {
    return undefined;
  }
  const hints = unionRelays(relays, eventRelayHints(coordinate), DEFAULT_RELAYS);
  const filter = { kinds: [KIND_EVENT_CONFIG], authors: [coord.pubkey], "#d": [coord.identifier] };
  const events = opts.fresh ? await fetchEventsRelayOnly(filter, hints) : await fetchEvents(filter, hints);
  // `authors` and `#d` are requests a relay may ignore. Organizer config writes
  // now rebuild the 31600 from this read and re-sign it with E_id, so a foreign
  // or mis-addressed event here would be laundered into the event's own config.
  const latest = pickLatest(onlyAddressed(onlyVerified(events), KIND_EVENT_CONFIG, coord.pubkey, coord.identifier));
  if (!latest) return undefined;
  try {
    return { config: parseEventConfig(coord.pubkey, latest.tags), createdAt: latest.created_at ?? 0 };
  } catch {
    return undefined;
  }
}

export const CONFIG_STALE =
  "The relays answered with an older copy of this event's settings than this device has " +
  "already seen, so nothing was published. Publishing from it would undo the newer change. " +
  "Wait a moment and try again.";

/**
 * Refuse a config rewrite built on a 31600 older than one this client already
 * knows exists (audit R-29). A relay that has not caught up with a detach or an
 * inbox rotation answers with the previous config, and `publishMonotonic` then
 * gives that stale content a winning created_at, re-attaching the old
 * coordinator for everyone.
 *
 * The floor is the page's own `knownAt` (`ctx.configAt`), plus the highest
 * created_at this client has published at the address (the monotonic watermark)
 * ONLY while an unsent publish for it is still in the outbox. The watermark is
 * bumped before the publish resolves, so on its own it would remember a 31600
 * that never reached any relay — discarded, or parked as failed — and refuse
 * every later edit on this device for good.
 */
export async function assertConfigNotStale(
  coordinate: string,
  createdAt: number,
  knownAt = 0,
): Promise<void> {
  const { pubkey, identifier } = parseCoordinate(coordinate);
  const pending = await hasPendingPublishFor(KIND_EVENT_CONFIG, pubkey, identifier);
  const watermark = pending ? publishWatermark(eventAddress(KIND_EVENT_CONFIG, pubkey, identifier)) : 0;
  if (createdAt < Math.max(knownAt, watermark)) throw new Error(CONFIG_STALE);
}

// Link status is asked once per approval, and "Approve all" approves dozens in a
// row: without a short memo that is one relay round-trip per attendee. Keyed by
// child coordinate; dropped whenever this client changes a link.
const LINK_TTL_MS = 60_000;
const linkMemo = new Map<string, { parent: string | undefined; at: number }>();

export function __resetLinkMemoForTests(): void {
  linkMemo.clear();
}

/**
 * The community this event is linked to RIGHT NOW (both sides agree, §15.1), or
 * undefined. Fail-soft: a relay gap yields "no proof", never an error, because an
 * approval must not fail on account of an optional field.
 */
export async function linkedParentFor(
  ctx: Pick<EventContext, "coordinate" | "config">,
  opts: { fresh?: boolean } = {},
): Promise<string | undefined> {
  const parent = ctx.config.parent;
  if (!parent) return undefined;
  const hit = linkMemo.get(ctx.coordinate);
  if (!opts.fresh && hit && Date.now() - hit.at < LINK_TTL_MS) return hit.parent;
  let linked: string | undefined;
  try {
    const parentCfg = await fetchNewestConfig(parent, ctx.config.relays, opts);
    if (parentCfg && isLinked(parent, parentCfg, ctx.coordinate, ctx.config)) linked = parent;
  } catch {
    return undefined; // not memoized: try again on the next grant
  }
  linkMemo.set(ctx.coordinate, { parent: linked, at: Date.now() });
  return linked;
}

/**
 * The `parent` field for a 21602 an organizer client seals with E_id (§15.3), or
 * an empty object when the event is not linked. Spread into the grant content.
 */
export async function grantParentField(
  ctx: Pick<EventContext, "coordinate" | "config">,
  eidSk: Uint8Array,
  attendee: string,
  opts: { fresh?: boolean } = {},
): Promise<{ parent?: MembershipProof }> {
  const parent = await linkedParentFor(ctx, opts);
  if (!parent) return {};
  return { parent: makeMembershipProof(eidSk, parent, ctx.coordinate, attendee) };
}

// ── Linking (organizer) ──────────────────────────────────────────────────────

async function republishConfig(
  coordinate: string,
  relays: string[],
  mutate: (cfg: EventConfig) => EventConfig,
): Promise<{ config: EventConfig; createdAt: number } | undefined> {
  const keys = await loadEventKeys(coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer E_id key not available");
  }
  const read = await fetchNewestSignedConfig(coordinate, relays, { fresh: true });
  if (!read) throw new Error("Event config (31600) not found");
  await assertConfigNotStale(coordinate, read.createdAt);
  const current = read.config;
  const next = mutate(current);
  const sameChildren = JSON.stringify(next.children ?? []) === JSON.stringify(current.children ?? []);
  if (sameChildren && next.parent === current.parent) return undefined; // nothing to change
  const eidSk = hexToBytes(keys.eidNsecHex);
  const built = buildEventConfig(configForSpace(next, coordinate));
  const publishRelays = unionRelays(relays, current.relays);
  const { createdAt } = await publishMonotonic({
    kind: built.kind,
    author: current.eidPubkey,
    identifier: current.d,
    relays: publishRelays,
    sign: (created_at) =>
      finalizeEvent({ kind: built.kind, created_at, tags: built.tags, content: built.content }, eidSk),
  });
  return { config: next, createdAt };
}

/** Keep the cached public context in step with a config this client just published. */
function refreshCachedContext(ctx: EventContext | undefined, config: EventConfig, at: number): void {
  if (!ctx) return;
  cacheEventContext({ ...ctx, config, configAt: at }, Math.max(at, ctx.contextAt ?? 0));
}

/** Add (or remove) a child on the community's 31600. Needs the community's E_id. */
export async function setCommunityChild(
  communityCoordinate: string,
  childCoordinate: string,
  present: boolean,
  relays: string[] = [],
): Promise<EventConfig | undefined> {
  if (!isCommunityCoordinate(communityCoordinate)) throw new Error("not a community");
  const out = await republishConfig(communityCoordinate, relays, (cfg) => {
    const rest = (cfg.children ?? []).filter((c) => c !== childCoordinate);
    const children = present ? [...rest, childCoordinate] : rest;
    return { ...cfg, children: children.length ? children : undefined };
  });
  linkMemo.clear();
  if (out) {
    const naddr = coordinateToNaddr(communityCoordinate, out.config.relays);
    refreshCachedContext(cachedEventContext(naddr), out.config, out.createdAt);
  }
  return out?.config;
}

/** Set (or clear) the parent on the event's own 31600. Needs the event's E_id. */
export async function setEventParent(
  ctx: EventContext,
  parent: string | undefined,
): Promise<EventConfig | undefined> {
  const out = await republishConfig(ctx.coordinate, ctx.config.relays, (cfg) => ({ ...cfg, parent }));
  linkMemo.clear();
  if (out) refreshCachedContext(cachedEventContext(ctx.naddr), out.config, out.createdAt);
  return out?.config;
}

/** A community this user organizes, with enough to show in a picker. */
export interface OrganizedCommunity {
  coordinate: string;
  naddr: string;
  title: string;
  config: EventConfig;
}

/** Communities whose E_id this device holds, with titles. Best-effort per entry. */
export async function listOrganizedCommunities(): Promise<OrganizedCommunity[]> {
  const keys = await listEventKeys().catch(() => []);
  const mine = keys.filter(
    (k) => k.role === "organizer" && !!k.eidNsecHex && isCommunityCoordinate(k.coordinate),
  );
  const loaded = await Promise.all(
    mine.map(async (k): Promise<OrganizedCommunity | undefined> => {
      try {
        const naddr = coordinateToNaddr(k.coordinate, eventRelayHints(k.coordinate));
        const ctx = cachedEventContext(naddr) ?? (await loadEventContext(naddr, { adoptLang: false }));
        return { coordinate: ctx.coordinate, naddr: ctx.naddr, title: ctx.title, config: ctx.config };
      } catch {
        return undefined;
      }
    }),
  );
  return loaded
    .filter((c): c is OrganizedCommunity => !!c)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export interface LinkOutcome {
  /** How many existing attendees were sent a fresh grant carrying the proof. */
  regranted: number;
}

/**
 * Link `child` to `community` (§15.1): the community lists it, then the event
 * names the community. In that order, so there is never a moment where the event
 * advertises a community that has not agreed.
 *
 * `regrant` is the organizer.ts routine that re-issues grants with the proof to
 * people already approved (§15.3); it is injected because organizer.ts imports
 * this module. Skipped for an event with a coordinator: the coordinator holds the
 * roster and the grant path.
 */
export async function linkEventToCommunity(
  child: EventContext,
  community: Pick<OrganizedCommunity, "coordinate" | "config">,
  regrant?: (ctx: EventContext) => Promise<number>,
): Promise<LinkOutcome> {
  await setCommunityChild(community.coordinate, child.coordinate, true, community.config.relays);
  const config = await setEventParent(child, community.coordinate);
  let regranted = 0;
  if (regrant && !child.config.coordinator) {
    const updated: EventContext = { ...child, config: config ?? { ...child.config, parent: community.coordinate } };
    regranted = await regrant(updated).catch(() => 0);
  }
  return { regranted };
}

/**
 * End the link from the event's side, and from the community's too when this
 * device organizes it. Memberships already granted are not revoked (§15.1).
 */
export async function unlinkEventFromCommunity(child: EventContext): Promise<void> {
  const parent = child.config.parent;
  await setEventParent(child, undefined);
  if (!parent) return;
  const keys = await loadEventKeys(parent).catch(() => undefined);
  if (keys?.role === "organizer" && keys.eidNsecHex) {
    await setCommunityChild(parent, child.coordinate, false).catch(() => undefined);
  }
}

// ── Reading a community's children ───────────────────────────────────────────

/**
 * Load each child's public context (title, start) and sort them. A child that
 * cannot be loaded (relay gap, deleted) is skipped, and one that no longer names
 * this community back is dropped: the listing is a link, and a one-sided claim is
 * not (§15.1). Loads run in parallel and failures never reject the whole list.
 */
export async function loadChildren(
  parent: string,
  parentCfg: Pick<EventConfig, "children" | "relays">,
  nowSec: number = Math.floor(Date.now() / 1000),
  load: (naddr: string) => Promise<EventContext> = (n) => loadEventContext(n, { adoptLang: false }),
): Promise<ChildSummary[]> {
  const out = await Promise.all(
    (parentCfg.children ?? []).map(async (child): Promise<ChildSummary | undefined> => {
      try {
        const naddr = coordinateToNaddr(child, parentCfg.relays);
        const ctx = await load(naddr);
        if (ctx.config.parent !== parent) return undefined;
        return { coordinate: child, naddr: ctx.naddr, title: ctx.title, start: ctx.start, icon: ctx.icon };
      } catch {
        return undefined;
      }
    }),
  );
  return sortChildren(
    out.filter((c): c is ChildSummary => !!c),
    nowSec,
  );
}

/**
 * Of the join requests in a community's queue, which carry a `member_of` claim
 * that verifies (§15.4)? Returns attendee pubkey -> the verified child. Child
 * configs are fetched once each, however many requests cite them.
 */
export async function verifyQueueMembership(
  parent: string,
  parentCfg: Pick<EventConfig, "children">,
  requests: { attendeePubkey: string; memberOf?: MemberOfClaim[] }[],
  fetchConfig: (coordinate: string) => Promise<EventConfig | undefined> = (c) => fetchNewestConfig(c),
): Promise<Map<string, string>> {
  const claimed = new Set(requests.flatMap((r) => (r.memberOf ?? []).map((m) => m.child)));
  const configs = new Map<string, EventConfig | undefined>();
  await Promise.all(
    [...claimed]
      .filter((c) => (parentCfg.children ?? []).includes(c))
      .map(async (c) => configs.set(c, await fetchConfig(c).catch(() => undefined))),
  );
  const verified = new Map<string, string>();
  for (const r of requests) {
    for (const claim of r.memberOf ?? []) {
      if (verifyMemberOfClaim(parent, parentCfg, claim, configs.get(claim.child), r.attendeePubkey)) {
        verified.set(r.attendeePubkey, claim.child);
        break;
      }
    }
  }
  return verified;
}

// ── A child event's view of its community ────────────────────────────────────

/** The community an event is (verifiably) part of, as the UI names it. */
export interface LinkedParent {
  coordinate: string;
  naddr: string;
  title: string;
  icon?: string;
}

function toLinkedParent(
  child: Pick<EventContext, "coordinate" | "config">,
  parentCtx: EventContext | undefined,
): LinkedParent | undefined {
  const parent = child.config.parent;
  if (!parent || !parentCtx || parentCtx.coordinate !== parent) return undefined;
  if (!isLinked(parent, parentCtx.config, child.coordinate, child.config)) return undefined;
  return { coordinate: parent, naddr: parentCtx.naddr, title: parentCtx.title, icon: parentCtx.icon };
}

function parentNaddr(child: Pick<EventContext, "config">, parent: string): string {
  const hints = unionRelays(eventRelayHints(parent), child.config.relays);
  return coordinateToNaddr(parent, hints);
}

/** Synchronous, cache-only: for the first paint. */
export function cachedLinkedParent(
  child: Pick<EventContext, "coordinate" | "config">,
): LinkedParent | undefined {
  const parent = child.config.parent;
  if (!parent) return undefined;
  return toLinkedParent(child, cachedEventContext(parentNaddr(child, parent)));
}

/**
 * The community this event is part of, or undefined. A parent tag nobody
 * reciprocates is not a link (§15.1), so this reads the community's own config
 * and says nothing when it does not list the event back. Never throws.
 */
export async function loadLinkedParent(
  child: Pick<EventContext, "coordinate" | "config">,
): Promise<LinkedParent | undefined> {
  const parent = child.config.parent;
  if (!parent) return undefined;
  try {
    const ctx = await loadEventContext(parentNaddr(child, parent), { adoptLang: false });
    return toLinkedParent(child, ctx);
  } catch {
    return undefined;
  }
}
