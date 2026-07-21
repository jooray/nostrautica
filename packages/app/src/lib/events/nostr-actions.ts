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
