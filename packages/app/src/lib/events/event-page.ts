/**
 * Event Page (spec §7.4 kind 31608): menu + layout, signed by E_id.
 *
 * Public menu items are ["r", target, label] tags in display order; public
 * layout sections live in cleartext content JSON. Members-only additions are
 * ECK-encrypted in `private`, each with a `pos` index into the MERGED list —
 * members interleave them client-side, visitors render the public parts alone.
 * No 31608 published → the default layout (the pre-customization event home).
 */
import { finalizeEvent } from "nostr-tools";
import { naddrEncode, decode } from "nostr-tools/nip19";
import {
  KIND_EVENT_PAGE,
  KIND_LONGFORM,
  KIND_MEMBERS_POST,
  parseCoordinate,
  hexToBytes,
  base64ToBytes,
  eventPageContentSchema,
  rTagsToMenu,
  menuToRTags,
  mergeMenu,
  mergeSections,
  splitMenu,
  splitSections,
  encryptEventPagePrivate,
  decryptEventPagePrivate,
  type EventPagePrivate,
  type ExternalFeed,
  type MergedMenuItem,
  type MergedSection,
} from "@nostrautica/protocol";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { loadEventKeys, currentEck } from "./keystore.js";
import type { EventContext } from "./event-context.js";
import { cacheGet, cacheSet, activeCacheOwner, ANON } from "$lib/cache/persist.js";

export interface EventPageModel {
  menu: MergedMenuItem[]; // merged, in display order; membersOnly flags kept
  sections: MergedSection[];
  /**
   * Long-form feeds by other npubs folded into this event's official posts
   * (31608 `sources`). Public and unencrypted — see externalFeedSchema.
   */
  sources: ExternalFeed[];
}

// The merged event page may contain decrypted private menu/sections, so it's
// owner-scoped when logged in (wiped on logout) and anon for visitors (public
// parts only). Persisted so EventHome paints menu/sections before the network
// (CACHING-PLAN §2.4).
function pageKey(coordinate: string): string {
  return `page:${coordinate}`;
}
function pageScope(): string {
  return activeCacheOwner() ?? ANON;
}

/** Cached merged event page for a coordinate (no network), or undefined. */
export function cachedEventPage(coordinate: string): EventPageModel | undefined {
  const hit = cacheGet<EventPageModel>(pageKey(coordinate), pageScope())?.data;
  if (!hit) return undefined;
  // Entries written by a build that predates external feeds have no `sources`.
  // Normalised here rather than at every call site, so consumers can treat the
  // field as always-present.
  return { ...hit, sources: hit.sources ?? [] };
}

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/**
 * Fetch + assemble the event page. Members-only parts decrypt with the ECK
 * version named by the event's `eck` tag (never assumed current); without the
 * key the public parts render alone. Returns undefined when no 31608 exists
 * (callers fall back to the default layout).
 */
export async function fetchEventPage(
  ctx: EventContext,
): Promise<EventPageModel | undefined> {
  const { pubkey, identifier } = parseCoordinate(ctx.coordinate);
  const events = await fetchEvents(
    { kinds: [KIND_EVENT_PAGE], authors: [pubkey], "#d": [identifier] },
    ctx.config.relays,
  );
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return undefined;
  let content;
  try {
    content = eventPageContentSchema.parse(JSON.parse(latest.content));
  } catch {
    return undefined; // malformed page — behave as if none exists
  }
  const publicMenu = rTagsToMenu(latest.tags);
  let priv: EventPagePrivate = { v: 2, menu: [], sections: [] };
  if (content.private) {
    const keys = await loadEventKeys(ctx.coordinate);
    const versionId = Number(tag(latest.tags, "eck")) || undefined;
    const version = keys?.eck.find((v) => v.id === versionId);
    if (version) {
      try {
        priv = decryptEventPagePrivate(base64ToBytes(version.key), content.private);
      } catch {
        /* can't decrypt (revoked / garbled) — public parts only */
      }
    }
  }
  const model: EventPageModel = {
    menu: mergeMenu(publicMenu, priv.menu),
    sections: mergeSections(content.sections, priv.sections),
    sources: content.sources,
  };
  cacheSet(pageKey(ctx.coordinate), model, latest.created_at ?? 0, pageScope());
  return model;
}

/**
 * Publish the event page from the admin editor's merged model, splitting
 * members-only items into the ECK-encrypted `private` payload (current ECK,
 * named by the `eck` tag). Organizer-only (E_id signature).
 */
export async function publishEventPage(
  ctx: EventContext,
  model: EventPageModel,
): Promise<PublishOutcome> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const { pubkey: eidPubkey, identifier } = parseCoordinate(ctx.coordinate);
  const menu = splitMenu(model.menu);
  const sections = splitSections(model.sections);

  const tags: string[][] = [
    ["d", identifier],
    ["a", ctx.coordinate],
    ["v", "2"],
  ];
  const hasPrivate =
    menu.privateItems.length > 0 || sections.privateItems.length > 0;
  let privateCiphertext: string | undefined;
  if (hasPrivate) {
    const eck = currentEck(keys);
    if (!eck) throw new Error("event content key not available");
    tags.push(["eck", String(eck.id)]);
    privateCiphertext = encryptEventPagePrivate(base64ToBytes(eck.key), {
      v: 2,
      menu: menu.privateItems,
      sections: sections.privateItems,
    });
  }
  tags.push(...menuToRTags(menu.publicItems));

  const content = JSON.stringify({
    v: 2,
    sections: sections.publicItems,
    // Omitted when empty so an event that declares no external feed publishes
    // byte-identical content to what pre-`sources` builds emitted.
    ...(model.sources.length ? { sources: model.sources } : {}),
    ...(privateCiphertext ? { private: privateCiphertext } : {}),
  });
  // Monotonic republish (audit P3): a same-second re-save of the page must win
  // the §3.1 tie-break, or the editor's change silently doesn't take.
  const { published } = await publishMonotonic({
    kind: KIND_EVENT_PAGE,
    author: eidPubkey,
    identifier,
    relays: ctx.config.relays,
    sign: (created_at) =>
      finalizeEvent(
        { kind: KIND_EVENT_PAGE, created_at, tags, content },
        hexToBytes(keys.eidNsecHex!),
      ),
  });
  return toOutcome(published);
}

// ── Menu targets ─────────────────────────────────────────────────────────────

/** naddr for one of this event's posts — the `nostr:` menu/pin target. */
export function postNaddr(ctx: EventContext, post: { kind: number; d: string }): string {
  const { pubkey } = parseCoordinate(ctx.coordinate);
  return naddrEncode({
    kind: post.kind,
    pubkey,
    identifier: post.d,
    relays: ctx.config.relays,
  });
}

export type ResolvedTarget =
  | { type: "url"; href: string } // plain https link
  | { type: "post"; d: string } // this event's 30023/31607 → internal route
  | { type: "naddr"; naddr: string }; // some other addressable event

/**
 * Classify a menu/pin target (spec §7.4): https URL, one of this event's own
 * posts (routed internally — a 31607 without the ECK shows lock + join), or a
 * foreign naddr (linked out).
 */
export function resolveTarget(ctx: EventContext, target: string): ResolvedTarget | undefined {
  if (/^https:\/\//.test(target)) return { type: "url", href: target };
  if (!target.startsWith("nostr:")) return undefined;
  const bech = target.slice("nostr:".length);
  try {
    const decoded = decode(bech);
    if (decoded.type !== "naddr") return undefined;
    const { kind, pubkey, identifier } = decoded.data;
    const { pubkey: eid } = parseCoordinate(ctx.coordinate);
    if (pubkey === eid && (kind === KIND_LONGFORM || kind === KIND_MEMBERS_POST)) {
      return { type: "post", d: identifier };
    }
    return { type: "naddr", naddr: bech };
  } catch {
    return undefined;
  }
}
