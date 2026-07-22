/**
 * Event updates (spec §7.1): NIP-23 long-form (kind 30023) authored by E_id.
 * The organizer's announcement channel — "schedule posted", "venue change" —
 * rendered on the event page and readable in any long-form Nostr client.
 *
 * Replaceable semantics: same `d` = edit. Readers MUST dedupe by `d` keeping
 * the highest created_at; `published_at` is set on first publish and preserved
 * on edits so ordering doesn't jump when an update is corrected.
 */
import { finalizeEvent } from "nostr-tools";
import { KIND_LONGFORM, parseCoordinate, hexToBytes, supersedes } from "@nostrautica/protocol";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { loadEventKeys } from "./keystore.js";
import type { EventContext } from "./event-context.js";

export interface EventUpdate {
  d: string;
  title: string;
  summary?: string; // optional cleartext teaser tag (spec §7.4 public posts)
  image?: string; // optional cleartext header-image tag
  content: string; // markdown
  publishedAt: number; // first-publish time (ordering)
  editedAt: number; // created_at of the winning revision
}

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/** Fetch the event's updates, deduped by `d` (highest created_at), newest first. */
export async function fetchEventUpdates(coordinate: string): Promise<EventUpdate[]> {
  const { pubkey } = parseCoordinate(coordinate);
  const events = await fetchEvents({ kinds: [KIND_LONGFORM], authors: [pubkey] });

  const byD = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const d = tag(e.tags, "d") ?? "";
    const seen = byD.get(d);
    if (!seen || supersedes(e, seen)) byD.set(d, e);
  }

  return [...byD.entries()]
    .map(([d, e]) => ({
      d,
      title: tag(e.tags, "title") ?? "Update",
      summary: tag(e.tags, "summary"),
      image: tag(e.tags, "image"),
      content: e.content,
      publishedAt: Number(tag(e.tags, "published_at")) || e.created_at || 0,
      editedAt: e.created_at ?? 0,
    }))
    .sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * Publish (or, with an existing `d`, edit) an event update signed by E_id.
 * Organizer-only: requires the E_id key in the local event keystore.
 */
export async function publishEventUpdate(
  ctx: EventContext,
  input: {
    d?: string;
    title: string;
    summary?: string;
    image?: string;
    content: string;
    publishedAt?: number;
  },
): Promise<EventUpdate> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const now = Math.floor(Date.now() / 1000);
  const d = input.d ?? `update-${now.toString(36)}`;
  const publishedAt = input.publishedAt ?? now;
  const tags = [
    ["d", d],
    ["title", input.title],
    ["published_at", String(publishedAt)],
    ["a", ctx.coordinate], // ties the update to the event for NIP-23 clients
  ];
  if (input.summary) tags.push(["summary", input.summary]);
  if (input.image) tags.push(["image", input.image]);
  const event = finalizeEvent(
    {
      kind: KIND_LONGFORM,
      created_at: now,
      tags,
      content: input.content,
    },
    hexToBytes(keys.eidNsecHex),
  );
  await publishOrQueue(event, ctx.config.relays);
  return {
    d,
    title: input.title,
    summary: input.summary,
    image: input.image,
    content: input.content,
    publishedAt,
    editedAt: now,
  };
}
