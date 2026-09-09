/**
 * A blob that can NEVER be fetched must not be retried forever (audit MED-5).
 *
 * `fetchBlob` threw a plain `Error` whatever the reason, and `processAttendee`
 * rethrows anything that is not a `MediaPolicyError` — so the whole attendee job
 * failed and re-ran on the retry schedule. For a corrupt or substituted blob, a
 * host the allowlist refuses, or a body past the byte cap, that is up to 26 full
 * downloads of every mirror over three days for an answer settled on the first
 * one, while the attendee is never matched.
 *
 * A transient failure must keep the long tail, though: that is what the tail is
 * for, and it is the distinction the whole 2026-09-09 audit round is about.
 */
import { describe, it, expect } from "vitest";
import { sha256Hex } from "@nostrautica/protocol";
import { fetchBlob, MediaPolicyError } from "./transcribe.js";
import { SafeFetchError } from "../net/safe-fetch.js";

const HASH = "a".repeat(64);
const MIRRORS = ["https://one.example/x", "https://two.example/x"];

/** What `fetchBlob` threw, or undefined when it resolved. */
async function thrownBy(fetch: (url: string) => Promise<Uint8Array>, hash = HASH): Promise<unknown> {
  try {
    await fetchBlob(MIRRORS, hash, { fetch: fetch as never });
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("fetchBlob failure classification", () => {
  it("a hash mismatch on every mirror is a POLICY rejection, not a retry", async () => {
    // The bytes arrived and are not the bytes the descriptor names. No number of
    // retries changes that.
    let calls = 0;
    const err = await thrownBy(async () => {
      calls++;
      return new Uint8Array([1, 2, 3]);
    });
    expect(err).toBeInstanceOf(MediaPolicyError);
    expect(calls).toBe(2); // both mirrors tried before giving up
  });

  it("a non-retryable policy rejection on every mirror is a POLICY rejection", async () => {
    const err = await thrownBy(async () => {
      throw new SafeFetchError("streamed bytes exceed cap", false);
    });
    expect(err).toBeInstanceOf(MediaPolicyError);
  });

  it("a TRANSIENT failure keeps the retry tail", async () => {
    const err = await thrownBy(async () => {
      throw new SafeFetchError("connect ETIMEDOUT", true);
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaPolicyError);
  });

  it("one transient mirror among permanent ones still keeps the tail", async () => {
    // Mixed evidence is not proof the blob is unfetchable: the mirror that timed
    // out might have served it.
    let call = 0;
    const err = await thrownBy(async () => {
      throw call++ === 0
        ? new SafeFetchError("blocked host", false)
        : new SafeFetchError("connect ETIMEDOUT", true);
    });
    expect(err).not.toBeInstanceOf(MediaPolicyError);
  });

  it("returns the bytes when a mirror serves the right ones", async () => {
    const data = new Uint8Array([9, 8, 7]);
    await expect(
      fetchBlob(MIRRORS, sha256Hex(data), { fetch: (async () => data) as never }),
    ).resolves.toEqual(data);
  });
});
