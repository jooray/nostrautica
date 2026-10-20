import { describe, it, expect } from "vitest";
import {
  canonicalEck,
  eckCandidates,
  eckCollisionIds,
  eckFingerprint,
  eckTag,
  readEckTag,
  unionEck,
} from "./eck-identity.js";
import { bytesToBase64 } from "./crypto.js";

const key = (b: number) => bytesToBase64(new Uint8Array(32).fill(b));
const v = (id: number, b: number) => ({ id, key: key(b) });

describe("ECK version identity (NIP §4.1, audit SB-86)", () => {
  it("fingerprints are 16 hex, stable, and differ per key", () => {
    const fp = eckFingerprint(key(1));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(eckFingerprint(key(1))).toBe(fp);
    expect(eckFingerprint(new Uint8Array(32).fill(1))).toBe(fp);
    expect(eckFingerprint(key(2))).not.toBe(fp);
  });

  it("a union keeps both keys of a same-id collision, in any order", () => {
    const phone = [v(1, 1), v(2, 2)];
    const laptop = [v(1, 1), v(2, 3)];
    const a = unionEck(phone, laptop);
    const b = unionEck(laptop, phone);
    expect(a).toEqual(b);
    expect(a.map((x) => x.id)).toEqual([1, 2, 2]);
    expect(eckCollisionIds(a)).toEqual([2]);
    expect(unionEck(a, a)).toEqual(a);
  });

  it("every holder of the same set picks the same current version", () => {
    const set = [v(1, 1), v(2, 2), v(2, 3)];
    const cur = canonicalEck(set)!;
    expect(cur.id).toBe(2);
    expect(canonicalEck([...set].reverse())).toEqual(cur);
    const lower = [key(2), key(3)].sort((x, y) => (eckFingerprint(x) < eckFingerprint(y) ? -1 : 1))[0];
    expect(cur.key).toBe(lower);
    // A later, unique id heals the collision.
    expect(canonicalEck([...set, v(3, 9)])!.id).toBe(3);
  });

  it("the eck tag names the key; readers without the fingerprint still read t[1]", () => {
    const tag = eckTag(v(2, 3));
    expect(tag).toEqual(["eck", "2", eckFingerprint(key(3))]);
    expect(readEckTag([tag])).toEqual({ id: 2, fp: eckFingerprint(key(3)) });
    expect(readEckTag([["eck", "2"]])).toEqual({ id: 2 });
    expect(readEckTag([["eck", "0"]])).toBeUndefined();
    expect(readEckTag([["eck", "2", "nothex"]])).toEqual({ id: 2 });
  });

  it("candidates pick the exact key, or say this device lacks it", () => {
    const held = [v(1, 1), v(2, 2)];
    expect(eckCandidates(held, readEckTag([eckTag(v(2, 2))])!)).toEqual([v(2, 2)]);
    expect(eckCandidates(held, readEckTag([eckTag(v(2, 3))])!)).toEqual([]); // the other device's v2
    expect(eckCandidates(held, { id: 2 })).toEqual([v(2, 2)]);
    expect(eckCandidates(held, { id: 3 })).toEqual([]);
  });
});
