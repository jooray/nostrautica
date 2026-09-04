/**
 * The v1 chat-device-key backup retirement (NIP §7.5): a once-per-account NIP-09
 * deletion of the legacy 31602 self-copy, addressed by the same blinded d the v1
 * backup used.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_DELETION, KIND_MY_PROFILE, blindedDLiteral } from "@nostrautica/protocol";

const BLIND_KEY = new Uint8Array(32).fill(7);
const deriveBlindingKey = vi.hoisted(() => vi.fn(async () => new Uint8Array(32).fill(7)));
vi.mock("$lib/events/blinding.js", () => ({ deriveBlindingKey }));
const publishSigned = vi.fn(async () => []);
vi.mock("$lib/nostr/ndk.js", () => ({ publishSigned: (...a: unknown[]) => publishSigned(...(a as [])) }));

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
  // Reset, not clear: several tests below install a persistent implementation
  // (a rejecting publish, a signer that never answers) and a leaked one would
  // quietly decide the next test's outcome.
  publishSigned.mockReset();
  publishSigned.mockResolvedValue([]);
  deriveBlindingKey.mockReset();
  deriveBlindingKey.mockResolvedValue(new Uint8Array(32).fill(7));
  vi.stubGlobal("localStorage", fakeLocalStorage());
});

describe("deleteLegacyChatDeviceKeyBackup", () => {
  it("publishes a NIP-09 deletion addressed to the legacy 31602 backup", async () => {
    await deleteLegacyChatDeviceKeyBackup(signer, ["wss://r"]);
    expect(publishSigned).toHaveBeenCalledOnce();
    const [event, relays] = publishSigned.mock.calls[0] as unknown as [
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
    expect(publishSigned).toHaveBeenCalledOnce();
  });

  it("does not set the marker when publishing throws (retries next session), and never durably queues (fire-and-forget hygiene, not user data)", async () => {
    publishSigned.mockRejectedValueOnce(new Error("relay down"));
    await deleteLegacyChatDeviceKeyBackup(signer);
    await deleteLegacyChatDeviceKeyBackup(signer);
    // First threw (marker unset), second succeeded → two attempts total.
    expect(publishSigned).toHaveBeenCalledTimes(2);
  });

  // The marker was only ever set on SUCCESS, so an account whose deletion kept
  // failing re-ran this on EVERY leader chat session, forever. The first thing it
  // does is `deriveBlindingKey(signer)` — for a NIP-46 account that is a round
  // trip to a remote signer, i.e. a prompt on the user's phone, before anything is
  // even published. Housekeeping for a backup most accounts never had must not tax
  // every chat start indefinitely.
  it("gives up after a few failed sessions instead of prompting the signer forever", async () => {
    publishSigned.mockRejectedValue(new Error("relay down"));
    for (let i = 0; i < 8; i++) await deleteLegacyChatDeviceKeyBackup(signer);
    expect(publishSigned).toHaveBeenCalledTimes(3);
  });

  it("stops paying the remote-signer round trip once it has given up", async () => {
    // The cap has to be checked BEFORE deriveBlindingKey, or the expensive part
    // still runs on every session and only the publish is skipped.
    publishSigned.mockRejectedValue(new Error("relay down"));
    for (let i = 0; i < 8; i++) await deleteLegacyChatDeviceKeyBackup(signer);
    expect(deriveBlindingKey).toHaveBeenCalledTimes(3);
  });

  it("counts an attempt even when the signer never answers", async () => {
    // A user who ignores the Amber prompt leaves this pending forever, so nothing
    // that runs "after" it can do the bookkeeping — the attempt must be recorded
    // on the way in.
    deriveBlindingKey.mockImplementation(() => new Promise<never>(() => {}));
    void deleteLegacyChatDeviceKeyBackup(signer);
    void deleteLegacyChatDeviceKeyBackup(signer);
    void deleteLegacyChatDeviceKeyBackup(signer);
    await Promise.resolve();
    await Promise.resolve();
    await deleteLegacyChatDeviceKeyBackup(signer);
    expect(deriveBlindingKey).toHaveBeenCalledTimes(3);
  });
});
