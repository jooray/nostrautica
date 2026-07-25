/**
 * Event Theme (spec §7.4 kind 31609): raw CSS ≤ 32 KB, public, signed E_id.
 * Deliberately NOT stored in 31600 content — config flows rebuild 31600 from
 * parsed tags and would silently drop it. The 32 KB cap is enforced on both
 * ends: publishers reject before signing, readers ignore oversize events.
 */
import { finalizeEvent } from "nostr-tools";
import {
  KIND_EVENT_THEME,
  parseCoordinate,
  hexToBytes,
  utf8ByteLength,
  MAX_THEME_CSS_BYTES,
} from "@nostrautica/protocol";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { loadEventKeys } from "./keystore.js";
import type { EventContext } from "./event-context.js";
import { cacheGet, cacheSet, ANON } from "$lib/cache/persist.js";

// Theme CSS is public, so it caches under the anon scope (CACHING-PLAN §2.12) and
// the injector applies it synchronously on route entry — no unthemed flash.
function themeKey(coordinate: string): string {
  return `theme:${coordinate}`;
}

/** Cached theme CSS for a coordinate (no network), or undefined. */
export function cachedEventTheme(coordinate: string): string | undefined {
  return cacheGet<string>(themeKey(coordinate), ANON)?.data || undefined;
}

/** The event's published CSS, or undefined (none / empty / over the cap). */
export async function fetchEventTheme(ctx: EventContext): Promise<string | undefined> {
  const { pubkey, identifier } = parseCoordinate(ctx.coordinate);
  const events = await fetchEvents(
    { kinds: [KIND_EVENT_THEME], authors: [pubkey], "#d": [identifier] },
    ctx.config.relays,
  );
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  const css = latest?.content ?? "";
  const valid = css.trim() && utf8ByteLength(css) <= MAX_THEME_CSS_BYTES;
  // Write-through: cache the CSS (or "" for "no theme") so the next entry paints
  // instantly. latest-wins on the 31609 created_at.
  cacheSet(themeKey(ctx.coordinate), valid ? css : "", latest?.created_at ?? 0, ANON);
  return valid ? css : undefined;
}

/**
 * Publish the event theme signed by E_id. An empty string clears the theme
 * (replaceable event with empty content). Rejects CSS over 32 KB. Returns the
 * publication outcome (R9) so the editor can distinguish a WSS-blocked queued
 * save (keep the draft) from a relay-confirmed publish.
 */
export async function publishEventTheme(ctx: EventContext, css: string): Promise<PublishOutcome> {
  const bytes = utf8ByteLength(css);
  if (bytes > MAX_THEME_CSS_BYTES) {
    throw new Error(
      `theme CSS is ${bytes} bytes — the limit is ${MAX_THEME_CSS_BYTES}`,
    );
  }
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const { pubkey: eidPubkey, identifier } = parseCoordinate(ctx.coordinate);
  // Monotonic republish (audit P3): a same-second theme edit (or clear) must win
  // the §3.1 tie-break, or the change silently doesn't take.
  const { published } = await publishMonotonic({
    kind: KIND_EVENT_THEME,
    author: eidPubkey,
    identifier,
    relays: ctx.config.relays,
    sign: (created_at) =>
      finalizeEvent(
        {
          kind: KIND_EVENT_THEME,
          created_at,
          tags: [
            ["d", identifier],
            ["a", ctx.coordinate],
            ["v", "2"],
          ],
          content: css,
        },
        hexToBytes(keys.eidNsecHex!),
      ),
  });
  return toOutcome(published);
}
