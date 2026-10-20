/**
 * ECK version identity across several organizer devices (audit SB-86,
 * PROTOCOL-NIP.md §4.1).
 *
 * An ECK version is numbered `max(held ids) + 1` by whoever rotates, and the
 * key is random. Two organizer devices (or an organizer and a co-organizer)
 * rotating concurrently therefore both mint "v2" with DIFFERENT keys, publish
 * records tagged `eck: 2`, and every receiver that union-merged versions BY ID
 * silently kept one key and dropped the other: half the event could read the
 * roster and half could not, and a recovery restored whichever half its backup
 * held, forever (rotation is forward-only).
 *
 * The identity of a version is therefore `(id, fingerprint)`, not `id`:
 *
 *  - `eckFingerprint(key)` = first 8 bytes of `sha256("nostrautica:eck-fp:" ‖ key)`,
 *    hex. Domain-separated and one-way, so it names a key without revealing it.
 *  - ECK-encrypted records MAY carry it as a third element of their `eck` tag:
 *    `["eck", "<id>", "<fp>"]`. Readers that know only `["eck", "<id>"]` read
 *    `t[1]` as before; readers that know the fingerprint pick the right key out
 *    of two that share an id, and can tell "a key I do not hold" apart from a
 *    corrupt record.
 *  - Every union keeps BOTH keys of a collision ({@link unionEck}); nothing
 *    downgrades to one.
 *  - Which of two same-id keys is "current" is a deterministic tie-break every
 *    holder computes alike: the highest id, then the LOWEST fingerprint
 *    ({@link canonicalEck}). Two devices that hold the same set always agree.
 *  - A collision is healed by moving forward: the next rotation mints
 *    `max id + 1`, which is unique again, and its re-grant carries every key
 *    including both colliding ones, so nothing ever encrypted becomes
 *    unreadable to someone who held it.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { base64ToBytes } from "./crypto.js";
import type { EckVersion } from "./schemas.js";

const FP_DOMAIN = utf8ToBytes("nostrautica:eck-fp:");
const FP_RE = /^[0-9a-f]{16}$/;

const fpMemo = new Map<string, string>();

/** 16-hex fingerprint of an ECK (base64 or raw bytes). Stable across ports; see the module doc. */
export function eckFingerprint(key: string | Uint8Array): string {
  if (typeof key !== "string") return bytesToHex(sha256(concatBytes(FP_DOMAIN, key))).slice(0, 16);
  const hit = fpMemo.get(key);
  if (hit) return hit;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(key);
  } catch {
    // Not base64 (never a schema-valid key, but a union must not throw on a
    // corrupt stored record): still a stable, distinct name for the string.
    bytes = utf8ToBytes(`!${key}`);
  }
  const fp = bytesToHex(sha256(concatBytes(FP_DOMAIN, bytes))).slice(0, 16);
  if (fpMemo.size > 4096) fpMemo.clear();
  fpMemo.set(key, fp);
  return fp;
}

function order(a: EckVersion, b: EckVersion): number {
  if (a.id !== b.id) return a.id - b.id;
  const fa = eckFingerprint(a.key);
  const fb = eckFingerprint(b.key);
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

/**
 * Union of ECK version lists by `(id, key)`: a version held by either side
 * survives, INCLUDING a second key under an id already held. Sorted by id, then
 * fingerprint, so the result is the same whatever order the lists came in.
 */
export function unionEck(...lists: EckVersion[][]): EckVersion[] {
  const seen = new Map<string, EckVersion>();
  for (const list of lists) for (const v of list) if (!seen.has(`${v.id}|${v.key}`)) seen.set(`${v.id}|${v.key}`, { id: v.id, key: v.key });
  return [...seen.values()].sort(order);
}

/** The current version: highest id, ties to the lowest fingerprint. */
export function canonicalEck(versions: EckVersion[]): EckVersion | undefined {
  let best: EckVersion | undefined;
  for (const v of versions) if (!best || v.id > best.id || (v.id === best.id && order(v, best) < 0)) best = v;
  return best;
}

/** Ids held under more than one distinct key (an unhealed SB-86 collision), ascending. */
export function eckCollisionIds(versions: EckVersion[]): number[] {
  const keys = new Map<number, Set<string>>();
  for (const v of versions) keys.set(v.id, (keys.get(v.id) ?? new Set()).add(v.key));
  return [...keys.entries()].filter(([, s]) => s.size > 1).map(([id]) => id).sort((a, b) => a - b);
}

/** The `eck` tag a writer puts on an ECK-encrypted record. */
export function eckTag(v: EckVersion): string[] {
  return ["eck", String(v.id), eckFingerprint(v.key)];
}

/** What an `eck` tag names. `fp` is absent on records from writers that predate it. */
export interface EckRef {
  id: number;
  fp?: string;
}

export function readEckTag(tags: string[][] | undefined): EckRef | undefined {
  const t = tags?.find((x) => x[0] === "eck");
  if (!t) return undefined;
  const id = Number(t[1]);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const fp = t[2]?.toLowerCase();
  return fp && FP_RE.test(fp) ? { id, fp } : { id };
}

/**
 * The held keys that may decrypt a record tagged `ref`, best first: the exact
 * `(id, fp)` match when the tag names a fingerprint, else every key under that
 * id with the canonical one first. Empty = this device does not hold the key
 * the record was written under.
 */
export function eckCandidates(versions: EckVersion[], ref: EckRef): EckVersion[] {
  const sameId = versions.filter((v) => v.id === ref.id).sort(order);
  if (ref.fp) return sameId.filter((v) => eckFingerprint(v.key) === ref.fp);
  return sameId;
}
