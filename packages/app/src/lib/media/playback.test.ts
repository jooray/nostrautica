/**
 * Object-URL cache discipline (audit APPR-4 / UX-28): the cache is ref-counted
 * per `x` (one player's unmount must not revoke a URL another player uses),
 * bounded by an LRU that evicts + revokes the oldest UNUSED entries, and any
 * descriptor claiming more than the download cap is rejected before the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MediaDescriptor } from "@nostrautica/protocol";

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock("$lib/blossom/client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, downloadBlob };
});
vi.mock("@nostrautica/protocol", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // Identity "decrypt": the ciphertext bytes ARE the plaintext in these tests.
  return { ...actual, decryptMedia: vi.fn(async (_d: unknown, ct: Uint8Array) => ct) };
});

import { MAX_MEDIA_DOWNLOAD_BYTES } from "$lib/blossom/client.js";

function descriptor(x: string, size = 3): MediaDescriptor {
  return { x, size, url: [`https://blossom.example/${x}`], m: "video/webm" } as MediaDescriptor;
}

describe("playback object-URL cache (APPR-4/UX-28)", () => {
  let resolveMediaUrl: (typeof import("./playback.js"))["resolveMediaUrl"];
  let releaseMediaUrl: (typeof import("./playback.js"))["releaseMediaUrl"];

  beforeEach(async () => {
    // The cache is module-level — re-import per test for isolation.
    vi.resetModules();
    ({ resolveMediaUrl, releaseMediaUrl } = await import("./playback.js"));
    downloadBlob.mockReset();
    downloadBlob.mockImplementation(async (urls: string[]) => new TextEncoder().encode(urls[0]));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an over-cap descriptor before ANY download", async () => {
    const big = descriptor("huge", MAX_MEDIA_DOWNLOAD_BYTES + 1);
    await expect(resolveMediaUrl(big)).rejects.toThrow(/limit/);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("one player's release does not revoke the URL another player still uses", async () => {
    const d = descriptor("shared");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const urlA = await resolveMediaUrl(d); // player A mounts
    const urlB = await resolveMediaUrl(d); // player B mounts — same URL, one download
    expect(urlB).toBe(urlA);
    expect(downloadBlob).toHaveBeenCalledTimes(1);

    releaseMediaUrl(d); // player A unmounts
    expect(revoke).not.toHaveBeenCalled(); // B is still playing it

    releaseMediaUrl(d); // player B unmounts — retained for a fast re-open
    const again = await resolveMediaUrl(d); // cache hit, still no re-download
    expect(again).toBe(urlA);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("LRU-evicts (+revokes) the oldest unused entry past 8, never an in-use one", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const ds = Array.from({ length: 8 }, (_, i) => descriptor(`m${i}`));
    const urls: string[] = [];
    for (const d of ds) urls.push(await resolveMediaUrl(d));
    for (const d of ds) releaseMediaUrl(d); // all zero-ref now

    // A 9th distinct media overflows the cache: the oldest zero-ref goes.
    const ninth = descriptor("m8");
    const url9 = await resolveMediaUrl(ninth);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(urls[0]);

    // m0 now re-downloads; m8 is still cached.
    const refetch = await resolveMediaUrl(ds[0]!);
    expect(refetch).not.toBe(urls[0]);
    expect(await resolveMediaUrl(ninth)).toBe(url9);
  });

  it("coalesces concurrent resolves of the same ciphertext into one download (App-3)", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // Gate the download so BOTH resolves are genuinely in flight at once.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    downloadBlob.mockImplementation(async (urls: string[]) => {
      await gate;
      return new TextEncoder().encode(urls[0]);
    });

    const d = descriptor("concurrent");
    const pA = resolveMediaUrl(d);
    const pB = resolveMediaUrl(d);
    open();
    const [urlA, urlB] = await Promise.all([pA, pB]);

    expect(urlB).toBe(urlA);
    expect(downloadBlob).toHaveBeenCalledTimes(1); // pre-fix this was 2 (leaked URL)

    // Two callers acquired one ref each: A's release must NOT revoke while B holds it.
    releaseMediaUrl(d);
    expect(revoke).not.toHaveBeenCalled();
    releaseMediaUrl(d); // both released — retained zero-ref within the bound
    expect(await resolveMediaUrl(d)).toBe(urlA); // cache hit, still a single download
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("broadcasts download progress to coalesced followers, not just the leader", async () => {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    downloadBlob.mockImplementation(
      async (urls: string[], _x: string, opts: { onProgress?: (p: unknown) => void }) => {
        await gate;
        opts.onProgress?.({ received: 0, total: 3 });
        opts.onProgress?.({ received: 3, total: 3 });
        return new TextEncoder().encode(urls[0]);
      },
    );

    const d = descriptor("progress");
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const pA = resolveMediaUrl(d, { onProgress: (p) => seenA.push(p) });
    const pB = resolveMediaUrl(d, { onProgress: (p) => seenB.push(p) });
    open();
    await Promise.all([pA, pB]);

    // B rode A's single download — it must still have seen the bytes move, or its
    // progress bar sits at 0% for the whole transfer.
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(seenA).toEqual([
      { received: 0, total: 3 },
      { received: 3, total: 3 },
    ]);
    expect(seenB).toEqual(seenA);

    // Listeners are dropped once the resolve settles — no growth across replays.
    seenA.length = 0;
    seenB.length = 0;
    releaseMediaUrl(d);
    releaseMediaUrl(d);
    await resolveMediaUrl(d); // cache hit: no download, no progress
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);
  });

  it("never evicts an entry that is still referenced", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // 9 LIVE players at once: the bound goes soft rather than revoking in-use URLs.
    const live = Array.from({ length: 9 }, (_, i) => descriptor(`live${i}`));
    const urls = [];
    for (const d of live) urls.push(await resolveMediaUrl(d));
    expect(revoke).not.toHaveBeenCalled();
    for (const d of live) releaseMediaUrl(d);
  });
});
