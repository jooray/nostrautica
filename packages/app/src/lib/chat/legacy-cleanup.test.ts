/**
 * The v1 chat-device-key backup retirement (NIP §7.5): a once-per-account NIP-09
 * deletion of the legacy 31602 self-copy, addressed by the same blinded d the v1
 * backup used.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_DELETION, KIND_MY_PROFILE, blindedDLiteral } from "@nostrautica/protocol";

const BLIND_KEY = new Uint8Array(32).fill(7);
vi.mock("$lib/events/blinding.js", () => ({ deriveBlindingKey: vi.fn(async () => BLIND_KEY) }));
const publishOrQueue = vi.fn(async () => {});
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue: (...a: unknown[]) => publishOrQueue(...(a as [])) }));

import { deleteLegacyChatDeviceKeyBackup } from "./legacy-cleanup.js";

const ACCOUNT = "a".repeat(64);
const signer = {
  getPublicKey: async () => ACCOUNT,
  signEvent: async (tpl: { kind: number; tags: string[][]; content: string; created_at: number }) => ({
    ...tpl,
    id: "sig-id",
    pubkey: ACCOUNT,
    sig: "0".repeat(128),
  }),
} as never;

function fakeLocalStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => {
  publishOrQueue.mockClear();
  vi.stubGlobal("localStorage", fakeLocalStorage());
});

describe("deleteLegacyChatDeviceKeyBackup", () => {
  it("publishes a NIP-09 deletion addressed to the legacy 31602 backup", async () => {
    await deleteLegacyChatDeviceKeyBackup(signer, ["wss://r"]);
    expect(publishOrQueue).toHaveBeenCalledOnce();
    const [event, relays] = publishOrQueue.mock.calls[0] as unknown as [
      { kind: number; tags: string[][] },
      string[],
    ];
    expect(event.kind).toBe(KIND_DELETION);
    const d = blindedDLiteral(BLIND_KEY, "chat-device-key");
    expect(event.tags).toContainEqual(["a", `${KIND_MY_PROFILE}:${ACCOUNT}:${d}`]);
    expect(event.tags).toContainEqual(["k", String(KIND_MY_PROFILE)]);
    expect(relays).toEqual(["wss://r"]);
  });

  it("runs at most once per account (marker-gated)", async () => {
    await deleteLegacyChatDeviceKeyBackup(signer);
    await deleteLegacyChatDeviceKeyBackup(signer);
    expect(publishOrQueue).toHaveBeenCalledOnce();
  });

  it("does not set the marker when publishing throws (retries next session)", async () => {
    publishOrQueue.mockRejectedValueOnce(new Error("relay down"));
    await deleteLegacyChatDeviceKeyBackup(signer);
    await deleteLegacyChatDeviceKeyBackup(signer);
    // First threw (marker unset), second succeeded → two attempts total.
    expect(publishOrQueue).toHaveBeenCalledTimes(2);
  });
});
