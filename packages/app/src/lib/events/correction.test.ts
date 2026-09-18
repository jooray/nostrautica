/**
 * `submitProfileCorrection` orchestration (spec F3, audit A-5).
 *
 * The transport collaborators are mocked so these assert what this module does:
 * the 21608 payload it seals to E_inbox, the `rev` it puts on it, and the fact
 * that the rev is recorded where a SECOND device will find it — the counter used
 * to live in device-local storage alone, so a fresh device re-sent rev 0 after
 * this one had reached rev 3 and the coordinator discarded the edit while the UI
 * said "saved".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const signerWrap = vi.fn();
const publishOrQueue = vi.fn();
const deriveBlindingKey = vi.fn();
const claimCorrectionRev = vi.fn();
const record = vi.fn();

vi.mock("$lib/events/giftwrap.js", () => ({ signerWrap: (...a: unknown[]) => signerWrap(...a) }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue: (...a: unknown[]) => publishOrQueue(...a) }));
vi.mock("$lib/events/blinding.js", () => ({ deriveBlindingKey: (...a: unknown[]) => deriveBlindingKey(...a) }));
vi.mock("$lib/media/submit.js", () => ({
  claimCorrectionRev: (...a: unknown[]) => claimCorrectionRev(...a),
}));

import { submitProfileCorrection } from "./correction.js";
import { KIND_PROFILE_CORRECTION } from "@nostrautica/protocol";

const OWN = "a".repeat(64);
const signer = { getPublicKey: async () => OWN } as unknown as import("$lib/signer/types.js").AppSigner;
const ctx = {
  coordinate: "31923:abcd:ev",
  config: { inbox: "b".repeat(64), relays: ["wss://r"] },
} as unknown as import("$lib/events/event-context.js").EventContext;

beforeEach(() => {
  vi.clearAllMocks();
  signerWrap.mockResolvedValue({ kind: 1059, id: "wrap" });
  publishOrQueue.mockResolvedValue(true);
  deriveBlindingKey.mockResolvedValue(new Uint8Array(32));
  record.mockResolvedValue(undefined);
  claimCorrectionRev.mockResolvedValue({ rev: 4, record });
});

describe("submitProfileCorrection (F3)", () => {
  it("seals a 21608 to E_inbox carrying the claimed rev", async () => {
    expect(await submitProfileCorrection(signer, ctx, { hidden: true })).toBe(true);
    const [, inbox, rumor] = signerWrap.mock.calls[0]!;
    expect(inbox).toBe(ctx.config.inbox);
    expect(rumor.kind).toBe(KIND_PROFILE_CORRECTION);
    expect(rumor.content).toMatchObject({ v: 2, a: ctx.coordinate, rev: 4, hidden: true });
    expect(rumor.tags).toContainEqual(["a", ctx.coordinate]);
  });

  it("records the rev for the next device, after the correction is sent", async () => {
    await submitProfileCorrection(signer, ctx, { hidden: true });
    expect(record).toHaveBeenCalledTimes(1);
    // Order matters: the correction goes out first, so a failure to record can
    // never cost the edit itself.
    expect(publishOrQueue.mock.invocationCallOrder[0]!).toBeLessThan(record.mock.invocationCallOrder[0]!);
  });

  it("still reports the correction's own outcome when recording the rev fails", async () => {
    record.mockRejectedValue(new Error("relay unreachable"));
    expect(await submitProfileCorrection(signer, ctx, { hidden: false })).toBe(true);
  });

  it("reports a queued (offline) correction as not published", async () => {
    publishOrQueue.mockResolvedValue(false);
    expect(await submitProfileCorrection(signer, ctx, { hidden: true })).toBe(false);
  });
});
