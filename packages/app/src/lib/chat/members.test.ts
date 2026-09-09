import { describe, it, expect } from "vitest";
import type { RosterContent } from "@nostrautica/protocol";
import {
  buildDeviceAccountMap,
  accountForDevice,
  chatMembers,
  devicesForAccount,
} from "./members.js";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const org = "0".repeat(64);
const aPhone = "a1".padEnd(64, "0");
const aLaptop = "a2".padEnd(64, "0");
const bPhone = "b1".padEnd(64, "0");
const orgDev = "01".padEnd(64, "0");

const roster: RosterContent = {
  v: 2,
  eck_current: 1,
  attendees: [
    {
      pubkey: alice,
      d: "d-alice",
      role: "attendee",
      chat_keys: [
        { pubkey: aPhone, label: "Phone", added_at: 100 },
        { pubkey: aLaptop, label: "Laptop", added_at: 200 },
      ],
    },
    { pubkey: bob, d: "d-bob", role: "attendee", chat_keys: [{ pubkey: bPhone, added_at: 150 }] },
    { pubkey: org, d: "d-org", role: "organizer", chat_keys: [{ pubkey: orgDev, label: "Org", added_at: 50 }] },
    // An attendee who hasn't opened chat — no chat_keys, never a chat member.
    { pubkey: "c".repeat(64), d: "d-c", role: "attendee" },
  ],
};

describe("buildDeviceAccountMap / accountForDevice", () => {
  it("maps each device key to its account and each account to itself", () => {
    const map = buildDeviceAccountMap(roster);
    expect(accountForDevice(aPhone, map)).toBe(alice);
    expect(accountForDevice(aLaptop, map)).toBe(alice);
    expect(accountForDevice(bPhone, map)).toBe(bob);
    expect(accountForDevice(alice, map)).toBe(alice);
  });

  it("falls back to the device key itself when unknown (fallback to device kind-0)", () => {
    const map = buildDeviceAccountMap(roster);
    const stranger = "f".repeat(64);
    expect(accountForDevice(stranger, map)).toBe(stranger);
  });

  it("is empty for an absent roster", () => {
    expect(buildDeviceAccountMap(undefined).size).toBe(0);
  });
});

describe("chatMembers", () => {
  it("returns one entry per person, organizer first, with a device count", () => {
    const { members, source } = chatMembers(roster);
    expect(members.map((m) => m.account)).toEqual([org, alice, bob]);
    expect(members.find((m) => m.account === alice)!.deviceCount).toBe(2);
    expect(members.find((m) => m.account === bob)!.deviceCount).toBe(1);
    // Nothing was passed about the MLS group, so this is the roster's answer and
    // the caller must be told so rather than shown it as room membership.
    expect(source).toBe("attested");
  });

  it("excludes attendees with no attested device", () => {
    const { members } = chatMembers(roster);
    expect(members.some((m) => m.account === "c".repeat(64))).toBe(false);
  });

  // ── real membership vs. attested devices ─────────────────────────────────
  // The list used to be derived from `chat_keys` alone — from who ATTESTED. That
  // is not who is in the room: a device whose Add failed (ineligible key package,
  // an invite that threw) is attested and cannot read a word, and a member whose
  // leaf was removed keeps their roster entry until the coordinator's next 31604.
  it("drops an attested device that holds no leaf in the group", () => {
    const { members, source } = chatMembers(roster, {
      // Bob attested but never made it in; alice is in on ONE of her two devices.
      groupDevices: [aPhone, orgDev],
    });
    expect(source).toBe("group");
    expect(members.map((m) => m.account)).toEqual([org, alice]);
    expect(members.find((m) => m.account === alice)!.deviceCount).toBe(1);
  });

  it("keeps a device that is in the group but not yet in the roster", () => {
    // The coordinator adds the member and republishes the roster separately, so
    // there is a window where a real member is missing from `chat_keys`. Their
    // messages are already arriving; hiding them would be the wrong half-truth.
    const newcomer = "e1".padEnd(64, "0");
    const { members } = chatMembers(roster, { groupDevices: [aPhone, newcomer] });
    expect(members.some((m) => m.account === newcomer)).toBe(true);
  });

  it("leaves the coordinator's own admin leaf out of the people list", () => {
    // The coordinator IS in the group — that is what the §4.5 disclosure says —
    // but rendering it with an avatar and a name reads as a mystery attendee.
    const coordinator = "c0".padEnd(64, "0");
    const { members } = chatMembers(roster, {
      groupDevices: [aPhone, coordinator],
      exclude: [coordinator],
    });
    expect(members.map((m) => m.account)).toEqual([alice]);
  });

  it("distinguishes an EMPTY group from an UNKNOWN one", () => {
    // `[]` is a real answer — a room nobody is in yet — and must render as empty.
    // `undefined` is "we can't see the group", which falls back to the roster and
    // says so. Collapsing the two would either invent members or erase them.
    const empty = chatMembers(roster, { groupDevices: [] });
    expect(empty.source).toBe("group");
    expect(empty.members).toEqual([]);

    const unknown = chatMembers(roster, { groupDevices: undefined });
    expect(unknown.source).toBe("attested");
    expect(unknown.members.length).toBeGreaterThan(0);
  });
});

describe("devicesForAccount", () => {
  it("lists an account's own attested devices with labels and timestamps", () => {
    const devices = devicesForAccount(roster, alice);
    expect(devices).toEqual([
      { pubkey: aPhone, label: "Phone", added_at: 100 },
      { pubkey: aLaptop, label: "Laptop", added_at: 200 },
    ]);
  });

  it("is empty for an account with no devices or an absent roster", () => {
    expect(devicesForAccount(roster, "c".repeat(64))).toEqual([]);
    expect(devicesForAccount(undefined, alice)).toEqual([]);
  });
});
