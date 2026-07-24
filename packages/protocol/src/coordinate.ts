/**
 * Event coordinate helpers. The event's canonical identifier everywhere is the
 * NIP-52 coordinate `31923:<E_id-pubkey>:<d>` (spec §6.1).
 */
import { naddrEncode, decode } from "nostr-tools/nip19";
import { KIND_CALENDAR_EVENT } from "./kinds.js";

export interface EventCoordinate {
  kind: number;
  pubkey: string; // E_id pubkey (hex)
  identifier: string; // the `d` tag
}

/** Build the `31923:<pubkey>:<d>` coordinate string. */
export function makeCoordinate(pubkey: string, d: string): string {
  return `${KIND_CALENDAR_EVENT}:${pubkey}:${d}`;
}

/** Parse a `kind:pubkey:d` coordinate. The identifier may itself contain colons. */
export function parseCoordinate(coordinate: string): EventCoordinate {
  const first = coordinate.indexOf(":");
  const second = coordinate.indexOf(":", first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`invalid coordinate: ${coordinate}`);
  }
  const kind = Number(coordinate.slice(0, first));
  const pubkey = coordinate.slice(first + 1, second);
  const identifier = coordinate.slice(second + 1);
  // The pubkey must be canonical lowercase hex (every downstream comparison is
  // case-sensitive) and the kind a NIP-01 16-bit integer (audit PROTO-5).
  if (
    !Number.isInteger(kind) ||
    kind < 0 ||
    kind > 65535 ||
    !/^[0-9a-f]{64}$/.test(pubkey)
  ) {
    throw new Error(`invalid coordinate: ${coordinate}`);
  }
  return { kind, pubkey, identifier };
}

/**
 * True iff `coordinate` is a canonical Nostrautica EVENT coordinate — a valid
 * `kind:pubkey:d` whose kind is exactly {@link KIND_CALENDAR_EVENT} (31923, audit
 * R18). The generic {@link parseCoordinate} deliberately accepts any Nostr kind
 * (naddr encode/decode, kind-0/10002 lookups, …); this is the stricter predicate
 * for anywhere an EVENT identity is required — a coordinator grant, key grant, or
 * membership coordinate — so an alias like `1:<E_id>:d` can't open a divergent
 * namespace against the same author/identifier.
 */
export function isEventCoordinate(coordinate: string): boolean {
  try {
    return parseCoordinate(coordinate).kind === KIND_CALENDAR_EVENT;
  } catch {
    return false;
  }
}

/**
 * Parse a coordinate that MUST be a Nostrautica event coordinate (kind exactly
 * {@link KIND_CALENDAR_EVENT} = 31923, audit R18). Throws on any other kind or a
 * malformed coordinate. Use at every boundary that installs/authorizes an event by
 * coordinate; use the generic {@link parseCoordinate} for non-event coordinates.
 */
export function parseEventCoordinate(coordinate: string): EventCoordinate {
  const parsed = parseCoordinate(coordinate);
  if (parsed.kind !== KIND_CALENDAR_EVENT) {
    throw new Error(
      `not a Nostrautica event coordinate (kind ${parsed.kind}, expected ${KIND_CALENDAR_EVENT}): ${coordinate}`,
    );
  }
  return parsed;
}

/** Encode an event coordinate as an naddr (optionally with relay hints). */
export function coordinateToNaddr(
  coordinate: string,
  relays: string[] = [],
): string {
  const { kind, pubkey, identifier } = parseCoordinate(coordinate);
  return naddrEncode({ kind, pubkey, identifier, relays });
}

/** Decode an naddr back into a coordinate + relay hints. */
export function naddrToCoordinate(naddr: string): {
  coordinate: string;
  relays: string[];
} {
  const decoded = decode(naddr);
  if (decoded.type !== "naddr") throw new Error("not an naddr");
  const { kind, pubkey, identifier, relays } = decoded.data;
  return {
    coordinate: `${kind}:${pubkey}:${identifier}`,
    relays: relays ?? [],
  };
}
