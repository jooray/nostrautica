import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network-facing collaborators so the test exercises withdraw.ts's own
// orchestration (the 21610 payload + the best-effort teardown), not the transport.
const signerWrap = vi.fn();
const publishOrQueue = vi.fn();
const deriveBlindingKey = vi.fn();
const loadSelfCopy = vi.fn();
const resolveBlossomServers = vi.fn();
const fetchUserBlossomServers = vi.fn();
const deleteBlob = vi.fn();

vi.mock("$lib/events/giftwrap.js", () => ({ signerWrap: (...a: unknown[]) => signerWrap(...a) }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue: (...a: unknown[]) => publishOrQueue(...a) }));
vi.mock("$lib/events/blinding.js", () => ({ deriveBlindingKey: (...a: unknown[]) => deriveBlindingKey(...a) }));
vi.mock("$lib/media/submit.js", () => ({
  loadSelfCopy: (...a: unknown[]) => loadSelfCopy(...a),
  resolveBlossomServers: (...a: unknown[]) => resolveBlossomServers(...a),
  fetchUserBlossomServers: (...a: unknown[]) => fetchUserBlossomServers(...a),
}));
vi.mock("$lib/blossom/client.js", () => ({ deleteBlob: (...a: unknown[]) => deleteBlob(...a) }));

import { withdrawFromEvent } from "./withdraw.js";
import { KIND_ATTENDEE_WITHDRAWAL, KIND_MY_PROFILE, KIND_DELETION } from "@nostrautica/protocol";

const OWN = "a".repeat(64);
const signer = {
  getPublicKey: async () => OWN,
  signEvent: vi.fn(async (t: unknown) => ({ ...(t as object), id: "sig", pubkey: OWN })),
} as unknown as import("$lib/signer/types.js").AppSigner;

const ctx = {
  coordinate: "31923:abcd:ev",
  config: { inbox: "b".repeat(64), relays: ["wss://r"], blossom: [] },
} as unknown as import("$lib/events/event-context.js").EventContext;

beforeEach(() => {
  vi.clearAllMocks();
  signerWrap.mockResolvedValue({ kind: 1059, id: "wrap" });
  publishOrQueue.mockResolvedValue(true);
  deriveBlindingKey.mockResolvedValue(new Uint8Array(32));
  loadSelfCopy.mockResolvedValue({ media: [{ x: "c".repeat(64) }, { x: "d".repeat(64) }] });
  resolveBlossomServers.mockReturnValue(["https://blossom.example"]);
  fetchUserBlossomServers.mockResolvedValue([]);
  deleteBlob.mockResolvedValue(true);
});

describe("withdrawFromEvent (NIP §6.3 21610)", () => {
  it("sends a 21610 to E_inbox with delete_data:true by default", async () => {
    await withdrawFromEvent(signer, ctx);
    expect(signerWrap).toHaveBeenCalledTimes(1);
    const [, inbox, rumor] = signerWrap.mock.calls[0]!;
    expect(inbox).toBe(ctx.config.inbox);
    expect(rumor.kind).toBe(KIND_ATTENDEE_WITHDRAWAL);
    expect(rumor.content).toMatchObject({ v: 2, a: ctx.coordinate, delete_data: true });
    expect(rumor.tags).toContainEqual(["a", ctx.coordinate]);
  });

  it("honors delete_data:false", async () => {
    await withdrawFromEvent(signer, ctx, { deleteData: false });
    expect(signerWrap.mock.calls[0]![2].content.delete_data).toBe(false);
  });

  it("best-effort deletes own Blossom blobs and NIP-09-deletes the 31602 self-copy", async () => {
    const res = await withdrawFromEvent(signer, ctx);
    // One delete attempt per blob hash, each to the resolved server.
    expect(res.blobsAttempted).toBe(2);
    expect(res.blobsDeleted).toBe(2);
    expect(deleteBlob).toHaveBeenCalledWith(signer, "https://blossom.example", "c".repeat(64));
    // A kind-5 deletion for the self-copy (31602) was signed + published.
    const del = (signer.signEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e.kind === KIND_DELETION);
    expect(del).toBeDefined();
    expect(del.tags.some((t: string[]) => t[0] === "k" && t[1] === String(KIND_MY_PROFILE))).toBe(true);
  });

  it("still reports the send even when teardown throws", async () => {
    loadSelfCopy.mockRejectedValue(new Error("relay down"));
    const res = await withdrawFromEvent(signer, ctx);
    expect(res.sent).toBe(true);
    expect(res.blobsAttempted).toBe(0);
  });
});
