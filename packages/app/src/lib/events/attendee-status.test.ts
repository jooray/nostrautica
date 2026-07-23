import { describe, it, expect, vi, beforeEach } from "vitest";

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const storeSet = vi.fn();

vi.mock("$lib/cache/persist.js", () => ({
  cacheGet: (...a: unknown[]) => cacheGet(...a),
  cacheSet: (...a: unknown[]) => cacheSet(...a),
}));
vi.mock("$lib/stores/own-status.svelte.js", () => ({
  ownStatusStore: { set: (...a: unknown[]) => storeSet(...a) },
}));

import { recordOwnStatus } from "./attendee-status.js";
import { KIND_COORDINATOR_STATUS, KIND_DM } from "@nostrautica/protocol";

const COORD_PK = "c".repeat(64);
const OWN = "a".repeat(64);
const A = "31923:eid:ev";

function statusRumor(sealer: string, content: object) {
  return { kind: KIND_COORDINATOR_STATUS, pubkey: sealer, content: JSON.stringify(content) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheGet.mockReturnValue(undefined);
});

describe("recordOwnStatus (NIP §6.3 attendee-scoped 21606)", () => {
  it("stores a poison status sealed by the configured coordinator", () => {
    const r = statusRumor(COORD_PK, { v: 2, a: A, stage: "process_talk", state: "poison", pubkey: OWN, at: 5 });
    expect(recordOwnStatus(r, OWN, COORD_PK)).toBe(true);
    expect(cacheSet).toHaveBeenCalled();
    expect(storeSet).toHaveBeenCalledWith(A, expect.arrayContaining([expect.objectContaining({ stage: "process_talk" })]));
  });

  it("ignores a status sealed by a non-coordinator key (still a status wrap)", () => {
    const r = statusRumor("f".repeat(64), { v: 2, a: A, stage: "process_talk", state: "poison", at: 5 });
    expect(recordOwnStatus(r, OWN, COORD_PK)).toBe(true);
    expect(storeSet).not.toHaveBeenCalled();
  });

  it("never surfaces a billing status to the attendee", () => {
    const r = statusRumor(COORD_PK, { v: 2, a: A, billing: { state: "payment_required" }, at: 5 });
    expect(recordOwnStatus(r, OWN, COORD_PK)).toBe(true);
    expect(storeSet).not.toHaveBeenCalled();
  });

  it("returns false for a non-status rumor (grant scan handles it elsewhere)", () => {
    expect(recordOwnStatus({ kind: KIND_DM, pubkey: COORD_PK, content: "{}" } as any, OWN, COORD_PK)).toBe(false);
  });
});
