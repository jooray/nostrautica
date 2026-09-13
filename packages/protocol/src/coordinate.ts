/**
 * Event coordinate helpers. The canonical identifier everywhere is the
 * coordinate `<kind>:<E_id-pubkey>:<d>` (spec §6.1), where the kind is 31923 for
 * a dated event and 31612 for a standing community.
 */
import { naddrEncode, decode } from "nostr-tools/nip19";
import { KIND_CALENDAR_EVENT, KIND_COMMUNITY } from "./kinds.js";

export interface EventCoordinate {
  kind: number;
  pubkey: string; // E_id pubkey (hex)
  identifier: string; // the `d` tag
}

/**
 * The two kinds a Nostrautica space can be published under. Everything that
 * requires an event identity checks membership of THIS list and nothing wider
 * (audit R18): the point of the guard is a bounded allowlist, not a single
 * value, so adding a second kind keeps it intact. The two namespaces stay
 * separate because every downstream record is keyed by the whole coordinate
 * string — `31612:X:d` authorises nothing for `31923:X:d`.
 */
export const SPACE_KINDS: readonly number[] = [KIND_CALENDAR_EVENT, KIND_COMMUNITY];

/** Build a `<kind>:<pubkey>:<d>` coordinate. Defaults to a dated event. */
export function makeCoordinate(
  pubkey: string,
  d: string,
  kind: number = KIND_CALENDAR_EVENT,
): string {
  return `${kind}:${pubkey}:${d}`;
}

/** True iff this coordinate names a standing community rather than a dated event. */
export function isCommunityCoordinate(coordinate: string): boolean {
  try {
    return parseCoordinate(coordinate).kind === KIND_COMMUNITY;
  } catch {
    return false;
  }
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
    return SPACE_KINDS.includes(parseCoordinate(coordinate).kind);
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
  if (!SPACE_KINDS.includes(parsed.kind)) {
    throw new Error(
      `not a Nostrautica event coordinate (kind ${parsed.kind}, expected one of ${SPACE_KINDS.join(", ")}): ${coordinate}`,
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
