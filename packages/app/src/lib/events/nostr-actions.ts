/**
 * Standard-Nostr actions that make registration double as Nostr onboarding
 * (spec §5.4). Each fetches the user's current replaceable event, merges, then
 * publishes — never blind-overwrites.
 */
import {
  KIND_PROFILE,
  KIND_CONTACTS,
  KIND_RELAY_LIST,
  KIND_DM_RELAY_LIST,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { onlyVerified } from "$lib/nostr/verify.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { ONBOARDING_RELAY_LIST, DM_RELAY_LIST } from "$lib/nostr/relays.js";
import { mergeProfileContent, mergeFollowTags, type Tag } from "./onboarding.js";
import { t } from "$lib/i18n/i18n.svelte.js";

async function latest(kind: number, pubkey: string) {
  const events = await fetchEvents({ kinds: [kind], authors: [pubkey] });
  // These reads feed merge-then-republish of the user's own lists — re-verify
  // before the latest-wins pick (audit APPK-1) so a forged "own" event can't
  // be merged and re-signed.
  return onlyVerified(events).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
}

/** Fetch existing kind-0, merge edited fields, publish (spec §5.4 item 1). */
export async function publishProfile(
  signer: AppSigner,
  edits: Record<string, string | undefined>,
): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const existing = await latest(KIND_PROFILE, pubkey);
  const content = mergeProfileContent(existing?.content, edits);
  const event = await signer.signEvent({
    kind: KIND_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  });
  await publishOrQueue(event);
}

/** Publish kind-10002 relay defaults IF the user has none yet (spec §5.4 item 2). */
export async function ensureRelayList(signer: AppSigner): Promise<boolean> {
  const pubkey = await signer.getPublicKey();
  const existing = await latest(KIND_RELAY_LIST, pubkey);
  if (existing) return false; // never override a user's existing relay list
  const tags: Tag[] = ONBOARDING_RELAY_LIST.map((r) =>
    r.read && r.write ? ["r", r.url] : ["r", r.url, r.read ? "read" : "write"],
  );
  const event = await signer.signEvent({
    kind: KIND_RELAY_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  });
  await publishOrQueue(event);
  return true;
}

/**
 * Build NIP-17 DM-relay-list (kind-10050) tags from a set of relay URLs. Pure so
 * the tag shape is unit-tested. NIP-17 tags are `["relay", <url>]`.
 */
export function dmRelayListTags(urls: string[]): Tag[] {
  return urls.map((url) => ["relay", url]);
}

/**
 * Publish a NIP-17 DM relay list (kind-10050) IF the user has none yet — same
 * fetch-first, never-override policy as `ensureRelayList` (spec §5.4). Without a
 * 10050, gift-wrapped DMs and future group chat don't reliably reach the user in
 * other clients. Returns true if a list was published, false if one already
 * existed. Only ever call this for keys the app generated itself.
 */
export async function ensureDmRelayList(signer: AppSigner): Promise<boolean> {
  const pubkey = await signer.getPublicKey();
  const existing = await latest(KIND_DM_RELAY_LIST, pubkey);
  if (existing) return false; // never override a user's existing DM relay list
  const event = await signer.signEvent({
    kind: KIND_DM_RELAY_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags: dmRelayListTags(DM_RELAY_LIST),
    content: "",
  });
  await publishOrQueue(event);
  return true;
}

/** The user's current follow (kind-3) tag set, or [] if none. */
export async function fetchFollowTags(signer: AppSigner): Promise<Tag[]> {
  const pubkey = await signer.getPublicKey();
  const existing = await latest(KIND_CONTACTS, pubkey);
  return (existing?.tags as Tag[]) ?? [];
}

/**
 * Follow a pubkey via a kind-3 fetch-merge-APPEND (spec §5.4 item 3). Always
 * fetches the current list first so pre-existing follows are never wiped.
 *
 * Empty-list guard: if the fetched list has zero follows we REFUSE to publish —
 * an empty fetch is indistinguishable from a failed fetch, and publishing
 * "just the new target" would look exactly like a wiped follow list. Keys the
 * app generates are seeded via `seedFollows` so they never hit this.
 *
 * Returns true when the kind-3 went out immediately, false when it was queued
 * for the offline flush (audit UX-15).
 */
export async function followUser(signer: AppSigner, target: string): Promise<boolean> {
  const pubkey = await signer.getPublicKey();
  const existing = await latest(KIND_CONTACTS, pubkey);
  const existingTags = (existing?.tags as Tag[]) ?? [];
  if (!existingTags.some((tag) => tag[0] === "p")) {
    throw new Error(t("error.followListGuard"));
  }
  const merged = mergeFollowTags(existingTags, [target]);
  const event = await signer.signEvent({
    kind: KIND_CONTACTS,
    created_at: Math.floor(Date.now() / 1000),
    tags: merged,
    // Carry the existing content through (audit UX-16): kind-3 content is legacy
    // relay-metadata JSON other clients still read — republishing "" wiped it.
    content: existing?.content ?? "",
  });
  return publishOrQueue(event);
}

/** Outcome of a `followAll` run — reported honestly to the user (spec §13). */
export interface FollowAllResult {
  /** Newly-followed pubkeys (added to the kind-3 this run). */
  followed: string[];
  /** Targets already in the follow list — nothing to do. */
  alreadyFollowing: string[];
  /** Targets that could not be followed (the publish failed). */
  failed: string[];
}

/** The follow-all plan derived from the current kind-3 tags and the target set. */
export interface FollowAllPlan {
  /** True when the current list has zero follows — the empty-list guard trips. */
  guardTripped: boolean;
  /** Targets already present in the list. */
  alreadyFollowing: string[];
  /** Targets not yet present, to be appended. */
  toAdd: string[];
  /** The merged tag set to publish (only when there is something to add). */
  mergedTags?: Tag[];
}

/**
 * Pure planner for `followAll` (spec §13). Splits `targets` against the current
 * kind-3 `existingTags` into already-following vs. to-add, and reports the same
 * empty-list guard `followUser` uses: a list with no `p` tags is indistinguishable
 * from a failed fetch, so appending to it would look like a wiped follow list.
 */
export function planFollowAll(existingTags: Tag[], targets: string[]): FollowAllPlan {
  const following = new Set(existingTags.filter((t) => t[0] === "p").map((t) => t[1]));
  const seen = new Set<string>();
  const alreadyFollowing: string[] = [];
  const toAdd: string[] = [];
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    if (following.has(target)) alreadyFollowing.push(target);
    else toAdd.push(target);
  }
  // Guard trips only when we'd actually publish (there's something to add) onto a
  // list that looks empty/unfetched. If everyone is already followed there's
  // nothing to publish, so an empty list is harmless.
  const guardTripped = toAdd.length > 0 && following.size === 0;
  return {
    guardTripped,
    alreadyFollowing,
    toAdd,
    ...(toAdd.length && !guardTripped ? { mergedTags: mergeFollowTags(existingTags, toAdd) } : {}),
  };
}

/**
 * Follow many pubkeys at once via a SINGLE kind-3 fetch-merge-append (spec §13
 * payoff flow): the post-event report's "follow everyone I met / want to meet".
 * Reuses the same empty-list guard as `followUser` — a fetch with no follows is
 * refused rather than risk publishing a wiped list. Reports the outcome honestly:
 * already-following targets are skipped, and if the single publish fails the
 * to-add targets are reported as failed, never as followed.
 */
export async function followAll(signer: AppSigner, targets: string[]): Promise<FollowAllResult> {
  const pubkey = await signer.getPublicKey();
  const existing = await latest(KIND_CONTACTS, pubkey);
  const existingTags = (existing?.tags as Tag[]) ?? [];
  const plan = planFollowAll(existingTags, targets);
  if (plan.guardTripped) throw new Error(t("error.followListGuard"));
  if (!plan.mergedTags) {
    return { followed: [], alreadyFollowing: plan.alreadyFollowing, failed: [] };
  }
  try {
    const event = await signer.signEvent({
      kind: KIND_CONTACTS,
      created_at: Math.floor(Date.now() / 1000),
      tags: plan.mergedTags,
      content: existing?.content ?? "",
    });
    await publishOrQueue(event);
    return { followed: plan.toAdd, alreadyFollowing: plan.alreadyFollowing, failed: [] };
  } catch {
    return { followed: [], alreadyFollowing: plan.alreadyFollowing, failed: plan.toAdd };
  }
}

/**
 * Seed a freshly-generated key's follow list with the event's E_id (spec §5.4
 * item 3): generated identities always have a non-empty kind 3, so the
 * empty-list guard in `followUser` never blocks them — and following the event
 * is an honest default. No-op if the key already has any follows. Only ever
 * call this for keys the app generated itself.
 */
export async function seedFollows(signer: AppSigner, eventPubkey: string): Promise<void> {
  const existing = await fetchFollowTags(signer);
  if (existing.some((tag) => tag[0] === "p")) return;
  const event = await signer.signEvent({
    kind: KIND_CONTACTS,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", eventPubkey]],
    content: "",
  });
  await publishOrQueue(event);
}
