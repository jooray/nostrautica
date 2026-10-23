import { describe, it, expect } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils";
import { mergeEventKeysBackups } from "./keys-backup.js";
import { bytesToBase64 } from "./crypto.js";
import { eventKeysBackupSchema, type EventKeysBackup } from "./schemas.js";

const k = (b: number) => bytesToBase64(new Uint8Array(32).fill(b));
const hex = (c: string) => c.repeat(64);
const base = (over: Partial<EventKeysBackup>): EventKeysBackup => ({
  v: 2,
  a: "31923:" + "e".repeat(64) + ":d",
  eid_nsec: hex("1"),
  einbox_nsec: hex("2"),
  eck: [{ id: 1, key: k(1) }],
  ...over,
});

describe("event-keys backup union (audit SB-89)", () => {
  it("keeps both devices' ECK versions and the higher install generation", () => {
    const phone = base({ eck: [{ id: 1, key: k(1) }, { id: 2, key: k(2) }], coordinator_gen: 1 });
    const laptop = base({ eck: [{ id: 1, key: k(1) }, { id: 2, key: k(3) }], coordinator_gen: 2 });
    const m = mergeEventKeysBackups(phone, laptop);
    expect(m.eck).toHaveLength(3);
    expect(m.coordinator_gen).toBe(2);
    expect(mergeEventKeysBackups(laptop, phone).eck).toEqual(m.eck);
    expect(eventKeysBackupSchema.safeParse(m).success).toBe(true);
  });

  it("makes the inbox the newest 31600 names current and keeps every other one as prior", () => {
    const phone = base({ einbox_nsec: hex("3"), prior_einbox_nsecs: [hex("2")] }); // phone rotated 2 → 3
    const laptop = base({ einbox_nsec: hex("4"), prior_einbox_nsecs: [hex("2")] }); // laptop rotated 2 → 4
    const configInbox = getPublicKey(hexToBytes(hex("4")));
    const m = mergeEventKeysBackups(phone, laptop, { configInbox });
    expect(m.einbox_nsec).toBe(hex("4"));
    expect(new Set(m.prior_einbox_nsecs)).toEqual(new Set([hex("2"), hex("3")]));
    // Without a config to go by, the caller's own copy stays current, and nothing is lost.
    const local = mergeEventKeysBackups(phone, laptop);
    expect(local.einbox_nsec).toBe(hex("3"));
    expect(new Set(local.prior_einbox_nsecs)).toEqual(new Set([hex("2"), hex("4")]));
  });

  it("a staged version stays staged unless the other copy already has it as current", () => {
    const v2 = { id: 2, key: k(2) };
    expect(mergeEventKeysBackups(base({ pending_eck: [v2] }), base({})).pending_eck).toEqual([v2]);
    const promoted = mergeEventKeysBackups(base({ pending_eck: [v2] }), base({ eck: [{ id: 1, key: k(1) }, v2] }));
    expect(promoted.pending_eck).toBeUndefined();
    expect(promoted.eck).toContainEqual(v2);
  });

  it("keeps every device's revocations, newest last, within the cap (R-04)", () => {
    const m = mergeEventKeysBackups(base({ revoked: [hex("a"), hex("b")] }), base({ revoked: [hex("b"), hex("c")] }));
    expect(new Set(m.revoked)).toEqual(new Set([hex("a"), hex("b"), hex("c")]));
    expect(eventKeysBackupSchema.safeParse(m).success).toBe(true);
    expect(mergeEventKeysBackups(base({}), base({})).revoked).toBeUndefined();
  });

  it("reads a backup written before these fields existed", () => {
    const old = { v: 2, eid_nsec: hex("1"), einbox_nsec: hex("2"), eck: [{ id: 1, key: k(1) }] };
    const m = mergeEventKeysBackups(eventKeysBackupSchema.parse(old), base({ coordinator_gen: 3 }));
    expect(m.coordinator_gen).toBe(3);
    expect(m.a).toBe(base({}).a);
  });
});
