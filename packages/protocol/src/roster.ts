/**
 * Roster pagination (PROTOCOL-NIP.md §6.2, kind `31604`).
 *
 * A 31604 is ONE NIP-44 v2 payload and that layer caps plaintext at 65,535
 * bytes. A `{pubkey, d, role}` entry costs ~135 bytes and one carrying a chat
 * device ~265, so a single-payload roster runs out somewhere between roughly 240
 * and 480 approved members — while `MAX_ROSTER` advertises 2,000 and a community
 * (31612) is a standing group that only ever grows. Past that ceiling the roster
 * is split across several 31604s addressed `<event-d>`, `<event-d>:1`,
 * `<event-d>:2`, … with a `pages` count on page 0.
 *
 * Two properties this module exists to guarantee, because getting either wrong
 * is worse than the ceiling was:
 *
 * 1. **A roster that fits is untouched.** {@link splitRoster} returns the very
 *    object it was handed — same reference, so the serialized bytes are
 *    identical to what shipped before pagination existed, `v: 2`, no `pages`
 *    key. Every client already installed keeps working on every roster below the
 *    ceiling, which is essentially all of them.
 * 2. **Page addressing lives in one place.** Every writer and every reader
 *    derives page `d`s through {@link rosterPageD}, so the coordinator, the app's
 *    organizer paths and the app's reader cannot drift into three dialects of
 *    the same scheme.
 *
 * A roster that DOES paginate declares `ROSTER_PAGED_VERSION` on page 0, so an
 * old client meets a payload from the future and fails loudly through the
 * existing `NewerProtocolVersionError` ("Update required") instead of rendering
 * 480 of 600 members as if that were the whole event. See the comment on
 * {@link ROSTER_PAGED_VERSION} in schemas.ts for why that `v` is a local
 * exception rather than a repo-wide wire bump.
 */
import { NIP44_MAX_PLAINTEXT_BYTES, utf8ByteLength } from "./event-page.js";
import {
  MAX_ROSTER,
  MAX_ROSTER_PAGES,
  PROTOCOL_VERSION,
  ROSTER_PAGED_VERSION,
  type RosterContent,
} from "./schemas.js";

/**
 * Packing budget for a page once a roster has actually paginated, deliberately
 * BELOW the 65,535-byte NIP-44 ceiling.
 *
 * The two thresholds are different numbers on purpose. Whether to paginate at
 * all is decided at the real ceiling ({@link rosterFitsOnePage}), so a roster
 * that fits today keeps fitting today and nothing about it changes. Once we are
 * paginating, pages are packed to this lower figure so that a page has headroom:
 * the attendee entries on it can each grow (a member attesting a chat device
 * roughly doubles their entry) without instantly pushing that page over the
 * ceiling on the next republish.
 */
export const ROSTER_PAGE_TARGET_BYTES = 60_000;

/**
 * The `d` of roster page `page`. Page 0 is the event's own `d` — unchanged,
 * which is what keeps an unpaginated roster at exactly the address it has always
 * been at — and page N is `<event-d>:N`.
 *
 * The suffix could in principle collide with a DIFFERENT space whose own `d`
 * literally ends in `:N` under the same coordinator. Readers close that by
 * requiring the page's `["a", <coordinate>]` tag to name the event they asked
 * about; the content is ECK-encrypted per event anyway, so the worst a collision
 * could do is withhold a page, never forge one.
 */
export function rosterPageD(identifier: string, page: number): string {
  if (!Number.isInteger(page) || page < 0) {
    throw new Error(`roster page index must be a non-negative integer, got ${page}`);
  }
  return page === 0 ? identifier : `${identifier}:${page}`;
}

/** Every page `d` of a `pages`-page roster, page 0 first. */
export function rosterPageDs(identifier: string, pages: number): string[] {
  return Array.from({ length: Math.max(1, pages) }, (_, i) => rosterPageD(identifier, i));
}

/**
 * Pages 1..pages-1 — exactly what a reader asks for after page 0 told it the
 * count, in ONE relay REQ (`#d: ["<d>:1", "<d>:2", …]`). Empty for a roster that
 * did not paginate, which is the case a reader should never spend a round trip
 * on.
 */
export function rosterContinuationDs(identifier: string, pages: number): string[] {
  return rosterPageDs(identifier, pages).slice(1);
}

/** How many pages page 0 says the roster has (1 when it is not paginated). */
export function rosterPageCountOf(page0: Pick<RosterContent, "pages">): number {
  return page0.pages ?? 1;
}

/** Serialized size of a roster payload in the bytes NIP-44 actually counts. */
function payloadBytes(roster: RosterContent): number {
  return utf8ByteLength(JSON.stringify(roster));
}

/** True when this roster still encrypts as a single 31604 payload. */
export function rosterFitsOnePage(roster: RosterContent): boolean {
  return payloadBytes(roster) <= NIP44_MAX_PLAINTEXT_BYTES;
}

/**
 * Build one wire page. Page 0 carries the fields that stay authoritative for the
 * whole roster — `eck_current` and `nostr_group_id` — plus the `pages` count;
 * continuation pages carry attendees and repeat `eck_current` (the schema
 * requires it and it costs ~20 bytes, but page 0 is the one readers take it
 * from).
 */
function buildPage(
  roster: RosterContent,
  index: number,
  pages: number,
  attendees: RosterContent["attendees"],
): RosterContent {
  if (index > 0) {
    return { v: ROSTER_PAGED_VERSION, eck_current: roster.eck_current, attendees };
  }
  return {
    v: ROSTER_PAGED_VERSION,
    eck_current: roster.eck_current,
    ...(roster.nostr_group_id ? { nostr_group_id: roster.nostr_group_id } : {}),
    pages,
    attendees,
  };
}

/**
 * Pack the attendee list into pages, front to back, without checking any limit.
 *
 * Front-to-back greedy packing is not an arbitrary choice: it is what makes an
 * approval cost ONE relay publish instead of N. Every page but the last is
 * filled to the budget and depends only on the PREFIX of the attendee list, so
 * appending a member leaves pages 0..N-2 byte-identical and touches only the
 * last one. That holds exactly as long as the caller's attendee order is
 * append-only — which is why the coordinator's `approvedAttendees` reads in
 * insertion order rather than whatever order the index happens to yield.
 */
function packPages(roster: RosterContent): RosterContent["attendees"][] {
  const groups: RosterContent["attendees"][] = [];
  let current: RosterContent["attendees"] = [];
  // Budget the envelope with the WIDEST `pages` value we could ever write, so
  // the real count (always ≤ MAX_ROSTER_PAGES, hence never more digits) can be
  // substituted afterwards without any page growing past what we measured.
  let overhead = payloadBytes(buildPage(roster, 0, MAX_ROSTER_PAGES, []));
  for (const attendee of roster.attendees) {
    // +1 for the comma that will separate this entry from the previous one. A
    // one-byte overestimate on the first entry of each page; harmless.
    const entry = utf8ByteLength(JSON.stringify(attendee)) + 1;
    if (current.length > 0 && overhead + entry > ROSTER_PAGE_TARGET_BYTES) {
      groups.push(current);
      current = [];
      overhead = payloadBytes(buildPage(roster, groups.length, MAX_ROSTER_PAGES, []));
    }
    current.push(attendee);
    overhead += entry;
  }
  groups.push(current);
  return groups;
}

/**
 * How many 31604s this roster would occupy. Non-throwing, so a capacity probe
 * ("would one more member still fit?") can ask without having to catch.
 */
export function rosterPageCount(roster: RosterContent): number {
  if (rosterFitsOnePage(roster)) return 1;
  return packPages(roster).length;
}

/**
 * Split a roster into the 31604 payloads that carry it.
 *
 * Returns `[roster]` — the same object, not a copy — whenever it still fits in
 * one payload, so a roster below the ceiling serializes to exactly the bytes it
 * always did and keeps `v: 2`. Above the ceiling every returned page declares
 * `ROSTER_PAGED_VERSION` and page 0 carries the count.
 *
 * Throws when the roster is past what pagination itself can carry (more than
 * `MAX_ROSTER` members or more than `MAX_ROSTER_PAGES` pages). Writers gate
 * before they get here — the coordinator refuses the approval and tells the
 * organizer — so a throw means a caller skipped its gate, which is worth being
 * loud about rather than publishing a page 0 whose own schema would reject it.
 */
export function splitRoster(roster: RosterContent): RosterContent[] {
  if (rosterFitsOnePage(roster)) return [roster];
  if (roster.attendees.length > MAX_ROSTER) {
    throw new Error(
      `roster has ${roster.attendees.length} members, over the ${MAX_ROSTER}-member cap`,
    );
  }
  const groups = packPages(roster);
  if (groups.length > MAX_ROSTER_PAGES) {
    throw new Error(
      `roster needs ${groups.length} pages, over the ${MAX_ROSTER_PAGES}-page cap`,
    );
  }
  const pages = groups.map((attendees, i) => buildPage(roster, i, groups.length, attendees));
  for (const [i, page] of pages.entries()) {
    const bytes = payloadBytes(page);
    if (bytes > NIP44_MAX_PLAINTEXT_BYTES) {
      // Unreachable given the budget above; assert rather than hand a caller a
      // page that will throw from inside eckEncrypt at publish time.
      throw new Error(
        `roster page ${i} is ${bytes} bytes, over the ${NIP44_MAX_PLAINTEXT_BYTES}-byte NIP-44 ceiling`,
      );
    }
  }
  return pages;
}

/**
 * Reassemble fetched pages into the one LOGICAL roster every consumer wants.
 *
 * Pagination is a wire detail: the merged value carries `v: PROTOCOL_VERSION`
 * and no `pages`, so the member list, the chat device dedupe and `eck_current`
 * all read it exactly as they read an unpaginated roster, and re-splitting it
 * reproduces the same pages. `eck_current` and `nostr_group_id` come from page
 * 0, which is authoritative for both.
 *
 * Pages must be given page-0-first. A member appearing on two pages is kept
 * once (first occurrence) — pages are addressed replaceables and a shrunken
 * roster leaves stale higher pages on relays that `pages` tells readers not to
 * ask for, but deduping here means even a confused read cannot double-count.
 */
export function mergeRosterPages(pages: RosterContent[]): RosterContent {
  const page0 = pages[0];
  if (!page0) throw new Error("cannot merge an empty roster page set");
  const seen = new Set<string>();
  const attendees: RosterContent["attendees"] = [];
  for (const page of pages) {
    for (const attendee of page.attendees) {
      if (seen.has(attendee.pubkey)) continue;
      seen.add(attendee.pubkey);
      attendees.push(attendee);
    }
  }
  return {
    v: PROTOCOL_VERSION,
    eck_current: page0.eck_current,
    ...(page0.nostr_group_id ? { nostr_group_id: page0.nostr_group_id } : {}),
    attendees,
  };
}
