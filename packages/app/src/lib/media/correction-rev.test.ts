/**
 * Audit A-5 — the 21608 correction `rev` has to be monotonic ACROSS DEVICES.
 *
 * The coordinator orders corrections by `(rev, created_at, id)` and discards any
 * that does not strictly supersede the applied one. The client kept this counter
 * in device-local storage alone, so a second device — or the same one after a
 * storage clear — started again from 0 while the coordinator still held rev 3.
 * Every edit that device made was therefore dropped server-side, and the UI
 * reported "saved" because the gift wrap really had gone out: delivery succeeded,
 * application did not, and nothing said so.
 *
 * The floor now comes from the relay-backed 31602 self-copy as well as the local
 * high-water mark — the same both-sources rule `nextRev` uses for submissions, so
 * a failed relay read can only fail to ADVANCE the counter, never roll it back.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { KIND_MY_PROFILE, blindedD } from "@nostrautica/protocol";
import { LocalSigner } from "$lib/signer/local.js";
import type { EventContext } from "$lib/events/event-context.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";

const { fetchEvents, fetchEventsRelayOnly, publishSigned } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly, publishSigned }));

import { claimCorrectionRev, cachedCorrectionRev } from "./submit.js";

function memPersist(): PersistBackend {
  const store = new Map<string, CacheEntry>();
  return {
    async getAll() {
      return [...store.entries()];
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

const BLINDING_KEY = new Uint8Array(32).fill(7);
const COORDINATE = "31923:" + "a".repeat(64) + ":cypherpunk";
const ctx = { coordinate: COORDINATE, config: { relays: ["wss://r"] } } as unknown as EventContext;

let signer: LocalSigner;
let pubkey: string;

/** A 31602 self-copy as it sits on a relay, self-encrypted to the owner. */
async function selfCopyEvent(content: Record<string, unknown>, createdAt = 1_700_000_000) {
  return {
    kind: KIND_MY_PROFILE,
    pubkey,
    created_at: createdAt,
    tags: [["d", blindedD(BLINDING_KEY, COORDINATE, pubkey)]],
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(content)),
    id: "self-copy",
    sig: "",
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // `publishOrQueue` only reaches the relay when it believes it is online; in the
  // node test environment `navigator` exists but reports nothing.
  vi.stubGlobal("navigator", { onLine: true });
  __resetPersistForTests();
  __setPersistBackend(memPersist());
  signer = LocalSigner.generate();
  pubkey = await signer.getPublicKey();
  setActiveCacheOwner(pubkey);
  fetchEvents.mockResolvedValue([]);
  fetchEventsRelayOnly.mockResolvedValue([]);
  publishSigned.mockResolvedValue([]);
});

describe("claimCorrectionRev (audit A-5)", () => {
  it("a FRESH device continues from the rev recorded on the self-copy", async () => {
    // Device A sent revs 0..3 and recorded the last one. Device B has empty local
    // storage: pre-fix it sent rev 0, which loses to the stored rev 3 and is
    // discarded by the coordinator while the UI says "saved".
    fetchEventsRelayOnly.mockResolvedValue([
      await selfCopyEvent({ v: 2, a: COORDINATE, media: [], rev: 5, correction_rev: 3 }),
    ]);
    const { rev } = await claimCorrectionRev(signer, ctx, BLINDING_KEY);
    expect(rev).toBe(4);
  });

  it("records the new rev on the self-copy, preserving the submission rev and intro", async () => {
    fetchEventsRelayOnly.mockResolvedValue([
      await selfCopyEvent({
        v: 2,
        a: COORDINATE,
        media: [],
        rev: 5,
        intro_text: "I build things",
        correction_rev: 3,
      }),
    ]);
    const { rev, record } = await claimCorrectionRev(signer, ctx, BLINDING_KEY);
    await record();

    expect(publishSigned).toHaveBeenCalledTimes(1);
    const published = publishSigned.mock.calls[0]![0] as { kind: number; content: string };
    expect(published.kind).toBe(KIND_MY_PROFILE);
    const written = JSON.parse(await signer.nip44Decrypt(pubkey, published.content));
    expect(written.correction_rev).toBe(rev);
    expect(written.rev).toBe(5); // the submission counter is NOT disturbed
    expect(written.intro_text).toBe("I build things");
  });

  it("a failed/empty relay read cannot roll the counter back", async () => {
    // Two corrections on this device, then the relay stops answering — which
    // `loadSelfCopy` reports as `undefined`, indistinguishable from "no self-copy".
    // The local high-water mark is what keeps the next rev moving forward.
    fetchEventsRelayOnly.mockResolvedValue([
      await selfCopyEvent({ v: 2, a: COORDINATE, media: [], correction_rev: 0 }),
    ]);
    expect((await claimCorrectionRev(signer, ctx, BLINDING_KEY)).rev).toBe(1);
    fetchEventsRelayOnly.mockRejectedValue(new Error("relay unreachable"));
    expect((await claimCorrectionRev(signer, ctx, BLINDING_KEY)).rev).toBe(2);
    expect(cachedCorrectionRev(COORDINATE)).toBe(2);
  });

  it("starts at 0 for an event that has never been corrected", async () => {
    fetchEventsRelayOnly.mockResolvedValue([await selfCopyEvent({ v: 2, a: COORDINATE, media: [], rev: 0 })]);
    expect((await claimCorrectionRev(signer, ctx, BLINDING_KEY)).rev).toBe(0);
  });
});
