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
    const members = chatMembers(roster);
    expect(members.map((m) => m.account)).toEqual([org, alice, bob]);
    expect(members.find((m) => m.account === alice)!.deviceCount).toBe(2);
    expect(members.find((m) => m.account === bob)!.deviceCount).toBe(1);
  });

  it("excludes attendees with no attested device", () => {
    const members = chatMembers(roster);
    expect(members.some((m) => m.account === "c".repeat(64))).toBe(false);
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
