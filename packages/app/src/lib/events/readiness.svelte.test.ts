/**
 * Regression cover for the bug that showed an ORGANIZER "1 of 5 · Join this
 * event" on their own event (reported 2026-07-24, Amber/NIP-46 login).
 *
 * Every input this store reads is owner-scoped, so while a NIP-46 session is
 * still restoring in the background they all answer "no" and the derivation
 * lands on "visitor — you need to join". The old store not only rendered that,
 * it CACHED it with an empty latch, so from the next visit on the wrong card
 * painted synchronously before any network work could correct it. These tests
 * pin the three rules that make that impossible: don't derive without an
 * identity, don't confuse a failed custody read with "not a member", and never
 * persist a negative verdict.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import type { EckVersion } from "@nostrautica/protocol";

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const loadEventKeys = vi.fn();
const cachedSelfCopy = vi.fn();
const loadSelfCopy = vi.fn();
const fetchDirectoryEntry = vi.fn();
const fetchMatches = vi.fn();
const hasDurableKeyBackup = vi.fn();

vi.mock("$lib/cache/persist.js", () => ({
  cacheGet: (...a: unknown[]) => cacheGet(...a),
  cacheSet: (...a: unknown[]) => cacheSet(...a),
}));
vi.mock("./keystore.js", () => ({
  loadEventKeys: (...a: unknown[]) => loadEventKeys(...a),
  currentEck: (keys?: { eck?: EckVersion[] }) =>
    keys?.eck?.length ? keys.eck[keys.eck.length - 1] : undefined,
}));
vi.mock("./attendee.js", () => ({
  fetchDirectoryEntry: (...a: unknown[]) => fetchDirectoryEntry(...a),
  fetchMatches: (...a: unknown[]) => fetchMatches(...a),
}));
vi.mock("./key-backup.js", () => ({
  hasDurableKeyBackup: (...a: unknown[]) => hasDurableKeyBackup(...a),
}));
vi.mock("./blinding.js", () => ({ deriveBlindingKey: async () => new Uint8Array(32) }));
vi.mock("$lib/media/submit.js", () => ({
  loadSelfCopy: (...a: unknown[]) => loadSelfCopy(...a),
  cachedSelfCopy: (...a: unknown[]) => cachedSelfCopy(...a),
  hasIntro: (self?: { media?: { kind: string }[]; introText?: string }) =>
    (self?.media ?? []).some((m) => m.kind === "intro") || !!self?.introText?.trim(),
}));
vi.mock("$lib/stores/join-sent.svelte.js", () => ({ joinSentAt: () => undefined }));
vi.mock("$lib/stores/backup-nag.svelte.js", () => ({ backupNag: { done: true } }));
vi.mock("$lib/stores/online.svelte.js", () => ({ online: { isOnline: true } }));

import { readinessStore } from "./readiness.svelte.js";
import type { ReadinessStepId } from "./readiness.js";

const PK = "a".repeat(64);
const ECK: EckVersion[] = [{ id: 1, key: "AAAA" }];

// A distinct coordinate per test: the monotonic latch is per-coordinate and
// deliberately survives `reset()`, so sharing one would leak "complete" across
// cases and hide exactly the regressions these tests exist to catch.
let n = 0;
function ctxFor(): EventContext {
  n++;
  return {
    naddr: `naddr1event${n}`,
    coordinate: `31923:${PK}:event-${n}`,
    config: { matching: "on", coordinator: "c".repeat(64) },
    title: "Event",
    summary: "",
    hashtags: [],
  } as unknown as EventContext;
}

const signer = (method: "local" | "nip07" | "nip46" = "nip46") =>
  ({ method, getPublicKey: async () => PK }) as unknown as AppSigner;

const stateOf = (id: ReadinessStepId) =>
  readinessStore.readiness?.steps.find((s) => s.id === id)?.state;

beforeEach(() => {
  vi.clearAllMocks();
  readinessStore.reset();
  cacheGet.mockReturnValue(undefined);
  cachedSelfCopy.mockReturnValue(undefined);
  loadSelfCopy.mockResolvedValue({ media: [] });
  fetchDirectoryEntry.mockResolvedValue(undefined);
  fetchMatches.mockResolvedValue(undefined);
  hasDurableKeyBackup.mockResolvedValue(true);
  loadEventKeys.mockResolvedValue(undefined);
});

describe("readinessStore: no identity, no verdict", () => {
  it("a signer-less load leaves the card untouched and writes nothing", async () => {
    const ctx = ctxFor();
    await readinessStore.load(ctx, null);
    expect(readinessStore.readiness).toBeUndefined();
    expect(readinessStore.coordinate).toBeUndefined();
    expect(cacheSet).not.toHaveBeenCalled();
    // It must not even ASK: the keystore read is owner-scoped and would answer
    // "holds nothing" for a user whose session hasn't finished restoring.
    expect(loadEventKeys).not.toHaveBeenCalled();
  });

  it("a signer-less primeLocal is a no-op too", () => {
    const ctx = ctxFor();
    readinessStore.primeLocal(ctx, null, undefined);
    expect(readinessStore.readiness).toBeUndefined();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("a caller that has CONFIRMED there is nobody to wait for still gets the Join CTA", async () => {
    // A genuinely logged-out visitor is a real visitor — the opt-in exists so
    // "nobody is logged in" stays distinguishable from "nobody YET".
    const ctx = ctxFor();
    await readinessStore.load(ctx, null, { anonymous: true });
    expect(stateOf("joined")).toBe("action-required");
    expect(readinessStore.readiness?.primary?.labelKey).toBe("readiness.cta.join");
  });
});

describe("readinessStore: custody", () => {
  it("an organizer is never told to join their own event", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "organizer", eck: ECK });
    await readinessStore.load(ctx, signer());
    expect(stateOf("joined")).toBe("complete");
    expect(readinessStore.readiness?.viewerIsMember).toBe(true);
    expect(readinessStore.readiness?.primary?.labelKey).not.toBe("readiness.cta.join");
  });

  it("a FAILED custody read shows 'checking', offers no CTA, and is never cached", async () => {
    // "IndexedDB threw" and "this identity holds nothing" used to collapse into
    // the same `.catch(() => undefined)`, so a transient storage error rendered —
    // and persisted — the claim that the viewer is not a member.
    const ctx = ctxFor();
    loadEventKeys.mockRejectedValue(new Error("IDB closed"));
    await readinessStore.load(ctx, signer());
    expect(stateOf("joined")).toBe("checking");
    expect(readinessStore.readiness?.primary).toBeUndefined();
    expect(readinessStore.readiness?.viewerIsMember).toBe(false);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("a visitor verdict is derived but NEVER persisted", async () => {
    const ctx = ctxFor();
    await readinessStore.load(ctx, signer());
    expect(stateOf("joined")).toBe("action-required");
    expect(readinessStore.readiness?.primary?.labelKey).toBe("readiness.cta.join");
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("a member verdict IS persisted, versioned, with a non-empty latch", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    await readinessStore.load(ctx, signer());
    expect(cacheSet).toHaveBeenCalled();
    const [key, value] = cacheSet.mock.calls.at(-1)!;
    expect(key).toBe(`readiness:${ctx.coordinate}`);
    const stored = value as { v: number; latched: ReadinessStepId[] };
    expect(stored.v).toBe(2);
    expect(stored.latched).toContain("joined");
  });

  it("ignores a v1 snapshot — those can be the poisoned 'you must join' ones", async () => {
    const ctx = ctxFor();
    cacheGet.mockReturnValue({
      at: 1,
      data: {
        readiness: { steps: [], doneCount: 0, currentIndex: 0, allComplete: false, matchesReady: false, viewerIsMember: false },
        latched: [],
      },
    });
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "organizer", eck: ECK });
    await readinessStore.load(ctx, signer());
    expect(readinessStore.readiness?.steps.length).toBeGreaterThan(0);
    expect(stateOf("joined")).toBe("complete");
  });
});

describe("readinessStore: one event at a time", () => {
  it("readiness always identifies the coordinate it belongs to", async () => {
    const a = ctxFor();
    const b = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: a.coordinate, role: "organizer", eck: ECK });
    await readinessStore.load(a, signer());
    expect(readinessStore.coordinate).toBe(a.coordinate);
    await readinessStore.load(b, signer());
    // The singleton now describes B — a page rendering A must be able to tell.
    expect(readinessStore.coordinate).toBe(b.coordinate);
  });

  it("reset() clears the previous event's card", async () => {
    const a = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: a.coordinate, role: "organizer", eck: ECK });
    await readinessStore.load(a, signer());
    readinessStore.reset();
    expect(readinessStore.readiness).toBeUndefined();
    expect(readinessStore.coordinate).toBeUndefined();
  });
});

describe("readinessStore: local phase", () => {
  it("primeLocal paints from the caller's keystore read alone — no network", () => {
    const ctx = ctxFor();
    cachedSelfCopy.mockReturnValue({ media: [{ kind: "intro" }] });
    readinessStore.primeLocal(ctx, signer(), {
      coordinate: ctx.coordinate,
      role: "organizer",
      eck: ECK,
    });
    expect(stateOf("joined")).toBe("complete");
    expect(stateOf("intro")).toBe("complete");
    expect(loadSelfCopy).not.toHaveBeenCalled();
    expect(fetchDirectoryEntry).not.toHaveBeenCalled();
  });

  it("a self-copy cache MISS is 'checking', never 'go record an intro'", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    loadSelfCopy.mockRejectedValue(new Error("relay down"));
    await readinessStore.load(ctx, signer());
    expect(stateOf("intro")).toBe("checking");
  });

  it("uses the authenticated own directory text intro as positive evidence", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    loadSelfCopy.mockResolvedValue(undefined);
    fetchDirectoryEntry.mockResolvedValue({ media: [], intro_text: "hello from the directory" });
    await readinessStore.load(ctx, signer());
    expect(stateOf("intro")).toBe("complete");
  });

  it("uses own directory intro media as positive evidence", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    loadSelfCopy.mockResolvedValue(undefined);
    fetchDirectoryEntry.mockResolvedValue({ media: [{ kind: "intro" }] });
    await readinessStore.load(ctx, signer());
    expect(stateOf("intro")).toBe("complete");
  });

  it("does not turn absent directory intro fields into negative evidence", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    loadSelfCopy.mockResolvedValue(undefined);
    fetchDirectoryEntry.mockResolvedValue({ media: [] });
    await readinessStore.load(ctx, signer());
    expect(stateOf("intro")).toBe("checking");
  });

  it("re-evaluates when delayed cache hydration supplies a self-copy", async () => {
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    loadSelfCopy.mockResolvedValue(undefined);
    await readinessStore.load(ctx, signer());
    expect(stateOf("intro")).toBe("checking");

    cachedSelfCopy.mockReturnValue({ media: [], introText: "hydrated later" });
    readinessStore.refreshFromCache();
    expect(stateOf("intro")).toBe("complete");
  });

  it("skips the self-copy fetch when the cache already proves an intro exists", async () => {
    // For a remote signer that fetch is a nip44Decrypt the user has to approve —
    // Amber popped a dialog on every single visit to confirm a step already
    // latched complete.
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    cachedSelfCopy.mockReturnValue({ media: [], introText: "hi, I build things" });
    await readinessStore.load(ctx, signer());
    expect(loadSelfCopy).not.toHaveBeenCalled();
    expect(stateOf("intro")).toBe("complete");
  });

  it("a local key's backup step waits for the DURABLE marker, not the dismiss-nag", async () => {
    // backupNag.done is stubbed true here; only the relay marker may complete
    // the step, or the monotonic latch would make one dishonest "secured"
    // permanent.
    const ctx = ctxFor();
    loadEventKeys.mockResolvedValue({ coordinate: ctx.coordinate, role: "attendee", eck: ECK });
    hasDurableKeyBackup.mockResolvedValue(false);
    await readinessStore.load(ctx, signer("local"));
    expect(stateOf("backup")).toBe("action-required");
  });
});
