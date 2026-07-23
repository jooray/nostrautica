/**
 * Duplicate-event prefill (spec §13): copies config, never identity. The prefill
 * must never carry keys, the coordinate, or the source `d`.
 */
import { describe, it, expect } from "vitest";
import { buildDuplicatePrefill } from "./duplicate.js";
import type { EventConfig } from "@nostrautica/protocol";

function config(over: Partial<EventConfig> = {}): EventConfig {
  return {
    d: "source-d-should-not-leak",
    eidPubkey: "e".repeat(64),
    inbox: "b".repeat(64),
    coordinator: "c".repeat(64),
    coordinatorGen: 3,
    relays: ["wss://relay"],
    blossom: ["https://blossom"],
    maxVideoSec: 120,
    maxTalkSec: 600,
    matching: "on",
    matchVisibility: "event",
    approval: "invite",
    eck: 4,
    nostrContext: 3,
    lang: "sk",
    talks: "prerecord-first",
    chat: ["marmot"],
    retentionDays: 30,
    ...over,
  } as EventConfig;
}

describe("buildDuplicatePrefill", () => {
  it("copies the settings the create form covers", () => {
    const p = buildDuplicatePrefill({ title: "DevConf", summary: "a great event", config: config() });
    expect(p).toMatchObject({
      title: "Copy of DevConf",
      summary: "a great event",
      talks: "prerecord-first",
      matching: "on",
      matchVisibility: "event",
      approval: "invite",
      lang: "sk",
      maxVideoSec: 120,
      maxTalkSec: 600,
      chatEnabled: true,
    });
  });

  it("never carries identity (coordinate, d, or any key)", () => {
    const p = buildDuplicatePrefill({ title: "X", summary: "", config: config() });
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("source-d-should-not-leak");
    expect(serialized).not.toContain("e".repeat(64)); // eidPubkey
    expect(serialized).not.toContain("b".repeat(64)); // inbox
    expect(serialized).not.toContain("c".repeat(64)); // coordinator
    // No identity-bearing keys on the prefill at all.
    for (const k of ["d", "coordinate", "eidPubkey", "inbox", "coordinator", "eck"]) {
      expect(Object.prototype.hasOwnProperty.call(p, k)).toBe(false);
    }
  });

  it("chatEnabled is false when the source had no chat backend", () => {
    expect(buildDuplicatePrefill({ title: "X", summary: "", config: config({ chat: [] }) }).chatEnabled).toBe(false);
  });
});
