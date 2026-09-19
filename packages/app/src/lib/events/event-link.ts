/**
 * Read an event link somebody pasted into the app.
 *
 * Why this exists at all: installed as a PWA, Nostrautica is a *separate
 * browser* from the one that opens links. Tapping an invite link in a chat app
 * hands it to the system browser, which has none of this device's identity — no
 * signer, no keystore, no joined events — so the invite lands in the one place
 * it is useless. Pasting the link into the app that already holds the identity
 * is the way around it, and this module is the parsing half: text in, a Route
 * out, so Home can navigate exactly as if the link had been opened here.
 *
 * Everything the app hands out is accepted, and so is most of what a link
 * survives being copied out of a chat message:
 *
 *   https://host/app/#/e/<naddr>/join?code=nsec1…&lang=sk   (invite link)
 *   https://host/app/#/e/<naddr>                            (shared event link)
 *   #/e/<naddr>/talks/<d>                                   (any deep link)
 *   nostr:naddr1…  /  naddr1…  /  https://njump.me/naddr1…  (bare address)
 *   31923:<E_id>:<d>  /  31612:<E_id>:<d>                   (raw coordinate)
 *
 * …and the same link after something en route has mangled it: percent-encoded
 * whole (`https%3A%2F%2Fhost%2Fapp%2F%23%2Fe%2F…`), carried as a click-tracker's
 * `?url=` parameter, or upper-cased. Those three used to resolve to the right
 * EVENT with the invite code silently gone, which is the worst outcome available
 * here — no error, and a one-tap join quietly downgraded to the approval queue.
 *
 * Dated events (31923) and standing communities (31612) both arrive through
 * here: `isEventCoordinate` accepts exactly the two SPACE_KINDS, which is also
 * what keeps an naddr for some *other* addressable kind — a long-form post, a
 * calendar from another app — from being filed as an event you can open.
 *
 * Pure (no DOM, no network, no store writes) so the accepted-shapes list above
 * is a unit test rather than a claim.
 */
import {
  coordinateToNaddr,
  isEventCoordinate,
  naddrToCoordinate,
} from "@nostrautica/protocol";
import { eventNaddr, parseHash, type Route } from "$lib/router/routes.js";

/**
 * Why a paste could not be turned into an event.
 *
 *  - `empty`       — nothing to parse; the caller shows no error for this.
 *  - `notAnEvent`  — a real Nostr address, pointing at something that is not a
 *                    Nostrautica event or community (an npub, a note, an naddr
 *                    of another kind). Worth saying out loud, because the user
 *                    pasted a link that IS valid and needs to know which one.
 *  - `unrecognized`— no address in there at all: a truncated link, the wrong
 *                    clipboard entry, the app's front page.
 */
export type EventLinkError = "empty" | "notAnEvent" | "unrecognized";

export type EventLinkResult =
  | {
      ok: true;
      /** Where to navigate — a join link keeps its `code`, a deep link its screen. */
      route: Route;
      /** The address the link names, in the spelling that decoded. */
      naddr: string;
      /** `<kind>:<E_id>:<d>` — the event's stable identity. */
      coordinate: string;
    }
  | { ok: false; reason: EventLinkError };

/**
 * A bech32 entity anywhere in the pasted text. The character class is the bech32
 * alphabet (no `1`, `b`, `i`, `o`), which is what lets this pick a naddr out of
 * "join us here: <https://njump.me/naddr1…>." without dragging the trailing
 * punctuation in with it.
 */
const ENTITY_RE = /(?:nostr:|web\+nostr:)?((?:naddr|nevent|nprofile|npub|note)1[02-9ac-hj-np-z]{10,})/gi;

/** A raw `<kind>:<64-hex pubkey>:<d>` coordinate anywhere in the text. */
const COORDINATE_RE = /\b(\d{1,5}:[0-9a-f]{64}:[^\s"'<>]+)/i;

/**
 * An invite `code=<nsec>` QUERY PARAMETER anywhere in the text — the last-resort
 * rescue for a link whose route didn't survive but whose code did.
 *
 * Anchored on `?`/`&`/`#` rather than matching a bare `nsec1…`: an nsec on its
 * own in pasted text is far more likely to be somebody's account key (which must
 * never be filed as an invite) than an invite code.
 */
const INVITE_CODE_RE = /[?&#]code=(nsec1[02-9ac-hj-np-z]{10,})/i;

/** What an address turned out to name. */
type Decoded =
  | { kind: "space"; naddr: string; coordinate: string }
  | { kind: "other" } // decodes fine, names something that isn't an event
  | { kind: "invalid" }; // not a decodable address at all

/**
 * Decode one candidate address, normalizing to the lowercase spelling.
 *
 * Bech32 is case-insensitive, so an address that went through something that
 * upper-cased it (a QR payload, an over-helpful mail client) still decodes — but
 * it must not be carried around in that spelling. `recent-events` keys the event
 * list on the naddr STRING, so an upper-cased one is a second card for an event
 * the user already has. Lowercase is the canonical spelling and the only one
 * anything else in the app ever produces; a mixed-case address is not valid
 * bech32 in either spelling and falls through to `invalid`.
 */
function decodeNaddr(candidate: string): Decoded {
  for (const spelling of [candidate.toLowerCase(), candidate]) {
    try {
      const { coordinate } = naddrToCoordinate(spelling);
      return isEventCoordinate(coordinate)
        ? { kind: "space", naddr: spelling, coordinate }
        : { kind: "other" };
    } catch {
      /* try the other spelling */
    }
  }
  return { kind: "invalid" };
}

/** The routes that name an event — exactly the ones `eventNaddr` answers for. */
type EventRoute = Extract<Route, { naddr: string }>;

function isEventRoute(route: Route): route is EventRoute {
  return eventNaddr(route) !== undefined;
}

/**
 * One percent-decoding pass, or undefined when that changes nothing / can't be
 * done. A link does not always arrive as a link: mail filters and click-tracking
 * gateways carry the real URL as a query parameter of their own
 * (`?url=https%3A%2F%2Fhost%2Fapp%2F%23%2Fe%2F…`), and some clients escape the
 * fragment marker on its own. Either way the `#` the parser looks for is a
 * literal `%23` and the whole route — invite code included — reads as opaque
 * text.
 */
function percentDecoded(text: string): string | undefined {
  if (!text.includes("%")) return undefined;
  try {
    const decoded = decodeURIComponent(text);
    return decoded === text ? undefined : decoded;
  } catch {
    return undefined; // a stray `%` that isn't an escape sequence
  }
}

/**
 * Every spelling of the pasted link's hash worth trying, best first.
 *
 * The original text always goes first, so a link that arrives intact is parsed
 * exactly as before and nothing below can change its meaning. The rescues are
 * for links that did NOT arrive intact, and each of them used to fail the same
 * silent way: the hash step found nothing, the bare-address scan below picked
 * the naddr back out, and the caller was handed an `event` route — the right
 * event, no invite code, no error. The person lands on the event page and joins
 * through the approval queue the code existed to skip (traced from a real join
 * 2026-09-17: the coordinator logged `invite=no`, and the shared code it should
 * have carried was live with 99 uses left).
 *
 * The lower-cased spelling is the other half of that: `parseHash` matches path
 * segments exactly, so a link an over-helpful client upper-cased has an `E`/
 * `JOIN` path it cannot read. Bech32 is case-insensitive and lowercase is its
 * canonical spelling, so lower-casing recovers both the address and the code.
 * It is only ever REACHED when the original spelling failed, which is what keeps
 * it from flattening a case-sensitive `d` identifier in a talk or post link.
 */
function hashCandidates(raw: string): string[] {
  const out: string[] = [];
  for (const text of [raw, percentDecoded(raw)]) {
    if (text === undefined) continue;
    const at = text.indexOf("#");
    if (at < 0) continue;
    const hash = text.slice(at);
    for (const spelling of [hash, hash.toLowerCase()]) {
      if (!out.includes(spelling)) out.push(spelling);
    }
  }
  return out;
}

/**
 * The invite code the pasted text carries, in canonical lowercase, or undefined.
 *
 * Used only to re-attach a code to an address that had to be recovered by the
 * scans below — i.e. when the route itself was unreadable. Dropping a live code
 * is the expensive failure (a queued join instead of a one-tap one) and carrying
 * a wrong one is the cheap one: an invite proof is signed over the event's
 * coordinate, so a code belonging to some other event simply doesn't validate
 * and the join lands exactly where it would have landed with no code at all.
 */
function inviteCode(raw: string): string | undefined {
  for (const text of [raw, percentDecoded(raw)]) {
    if (text === undefined) continue;
    const match = INVITE_CODE_RE.exec(text);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

/** An address with no route of its own: a join link when a code was rescued. */
function addressRoute(naddr: string, code: string | undefined): Route {
  return code ? { name: "join", naddr, code } : { name: "event", naddr };
}

export function parseEventLink(raw: string): EventLinkResult {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "empty" };

  // Did we see a real address that simply isn't an event? That is a different
  // sentence to the user than "there's no link in what you pasted", and it is
  // the only reason this is tracked rather than returning on the first miss.
  let sawOther = false;

  // 1. A hash route — the shape of every link this app hands out. Taken first
  //    and whole, because it is the only form that carries an invite `code`,
  //    and losing that would turn a one-tap join into "ask the organizer again".
  //    Tried in every spelling the link might have arrived in (hashCandidates),
  //    original first.
  for (const hash of hashCandidates(input)) {
    const route = parseHash(hash);
    if (!isEventRoute(route)) continue;
    const decoded = decodeNaddr(route.naddr);
    if (decoded.kind === "space") {
      return {
        ok: true,
        // The route's own screen, with the address normalized (see decodeNaddr).
        route: { ...route, naddr: decoded.naddr },
        naddr: decoded.naddr,
        coordinate: decoded.coordinate,
      };
    }
    sawOther ||= decoded.kind === "other";
    // An unreadable naddr in the hash falls through deliberately: a link
    // copied out of a chat message can arrive wrapped in punctuation the
    // router happily parses as part of the address, and the scan below
    // picks the address back out of it.
  }

  // Any code the text carries, for the scans below — the hash step above already
  // has the route's own, and must keep it even when this finds nothing.
  const rescuedCode = inviteCode(input);

  // 2. A bare address, with or without the `nostr:` scheme, anywhere in the
  //    text — a njump link, a paste with words around it, an naddr on its own.
  for (const match of input.matchAll(ENTITY_RE)) {
    const entity = match[1];
    if (!/^naddr1/i.test(entity)) {
      sawOther = true; // an npub/note/nevent: valid, just not an event
      continue;
    }
    const decoded = decodeNaddr(entity);
    if (decoded.kind === "space") {
      return {
        ok: true,
        route: addressRoute(decoded.naddr, rescuedCode),
        naddr: decoded.naddr,
        coordinate: decoded.coordinate,
      };
    }
    sawOther ||= decoded.kind === "other";
  }

  // 3. A raw coordinate. Nothing in the UI copies one, but they are all over the
  //    docs and the debug surfaces, and turning one into a link is free.
  const coordinate = COORDINATE_RE.exec(input)?.[1];
  if (coordinate) {
    if (isEventCoordinate(coordinate)) {
      try {
        const naddr = coordinateToNaddr(coordinate);
        return { ok: true, route: addressRoute(naddr, rescuedCode), naddr, coordinate };
      } catch {
        /* an identifier we can't encode — fall through to the error below */
      }
    } else {
      sawOther = true;
    }
  }

  return { ok: false, reason: sawOther ? "notAnEvent" : "unrecognized" };
}
