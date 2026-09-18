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
  const hashAt = input.indexOf("#");
  if (hashAt >= 0) {
    const route = parseHash(input.slice(hashAt));
    if (isEventRoute(route)) {
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
  }

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
        route: { name: "event", naddr: decoded.naddr },
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
        return { ok: true, route: { name: "event", naddr }, naddr, coordinate };
      } catch {
        /* an identifier we can't encode — fall through to the error below */
      }
    } else {
      sawOther = true;
    }
  }

  return { ok: false, reason: sawOther ? "notAnEvent" : "unrecognized" };
}
