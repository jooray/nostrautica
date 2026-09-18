/**
 * Warm what the Chat screen RENDERS, while the user is still on the event page.
 *
 * The session prewarm (layout → `chatSession.ensure`) already gets the expensive
 * half of chat — the MLS handshake, the welcome, the live 445 stream — running in
 * the background, so by the time Chat is tapped the room usually holds its
 * messages already. What it does not warm is the display layer around them: every
 * sender bubble and every member row resolves a kind-0 for a chat DEVICE key (and
 * for the account it is attested to), and those fetches used to start only once
 * the page had mounted and the first messages had rendered. The result was a room
 * that painted as a wall of "npub1q2w…" and truncated keys that turned into names
 * a relay round-trip later.
 *
 * Every pubkey that needs a profile is knowable in advance: the ECK roster's
 * `chat_keys` bind each attendee account to its attested device keys, and the
 * roster is already on this device (People warms it; the Chat page reads it from
 * cache). So warm the profiles for that whole set up front — public kind-0s, no
 * signer, no prompt, no decryption — and the room paints with names on it.
 *
 * Deliberately fire-and-forget and deduped: a warmer that throws, or that runs
 * twice because the user bounced between tabs, must cost nothing and must never
 * be able to fail an actual chat session (this is called from the session start).
 */
import type { EventContext } from "$lib/events/event-context.js";
import { cachedRoster, fetchRoster } from "$lib/events/attendee.js";
import { fetchProfiles } from "$lib/events/social.js";
import type { RosterContent } from "@nostrautica/protocol";

/** A repeat trigger within this window is a no-op (matches prefetch.ts's TTL). */
const TTL_MS = 30_000;

const inflight = new Set<string>();
const doneAt = new Map<string, number>();

/**
 * Every pubkey the chat UI resolves a name/avatar for: each attendee's account
 * key (the identity a message is attributed to after the roster dedupe) and each
 * attested device key (the pubkey the message is actually signed by, and the
 * fallback profile when the roster has no row for it yet).
 */
export function chatProfilePubkeys(roster: RosterContent | undefined): string[] {
  const out = new Set<string>();
  for (const a of roster?.attendees ?? []) {
    out.add(a.pubkey);
    for (const k of a.chat_keys ?? []) out.add(k.pubkey);
  }
  return [...out];
}

/**
 * Warm the Chat tab's render data for an event. Safe to call repeatedly (and from
 * the session prewarm, which fires on every event page); never throws.
 */
export function warmChatTab(ctx: EventContext): void {
  const key = ctx.coordinate;
  const at = doneAt.get(key);
  if (at !== undefined && Date.now() - at < TTL_MS) return;
  if (inflight.has(key)) return;
  inflight.add(key);
  void (async () => {
    try {
      // Cached roster first: the People warmers usually have it already, and the
      // profile set is the point of this warmer — waiting on a roster refetch we
      // don't need would delay it for nothing.
      const roster = cachedRoster(ctx.coordinate) ?? (await fetchRoster(ctx));
      const pubkeys = chatProfilePubkeys(roster);
      if (pubkeys.length) await fetchProfiles(pubkeys);
    } catch {
      /* best-effort: the page re-fetches what it still misses on mount */
    } finally {
      // Stamped on failure too, for the reason prefetch.ts's `warm` documents: a
      // dead relay must not turn every re-entry into another full timeout.
      doneAt.set(key, Date.now());
      inflight.delete(key);
    }
  })();
}

/** Test-only: forget the dedupe/TTL bookkeeping between cases. */
export function __resetChatWarmForTests(): void {
  inflight.clear();
  doneAt.clear();
}
