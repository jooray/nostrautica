import { describe, it, expect } from "vitest";
import { encryptMedia, decryptMedia, freshCopy } from "./media.js";
import { mediaDescriptorSchema } from "./schemas.js";
import { sha256Hex } from "./crypto.js";

const sampleUrl = "https://blossom.example/blob.bin";

describe("media descriptor + AES-GCM (spec §6.2)", () => {
  it("encrypts, produces a valid descriptor, and decrypts back", async () => {
    const data = crypto.getRandomValues(new Uint8Array(2048));
    const { ciphertext, descriptor } = await encryptMedia({
      kind: "intro",
      data,
      mime: "video/webm",
      duration: 42,
      urls: [sampleUrl],
    });

    // descriptor is schema-valid and the hashes are correct
    mediaDescriptorSchema.parse(descriptor);
    expect(descriptor.x).toBe(sha256Hex(ciphertext));
    expect(descriptor.ox).toBe(sha256Hex(data));
    expect(descriptor.size).toBe(ciphertext.length);

    // The descriptor survives relay transport (JSON) and still decrypts.
    const transported = mediaDescriptorSchema.parse(
      JSON.parse(JSON.stringify(descriptor)),
    );
    const back = await decryptMedia(transported, ciphertext);
    expect(back).toEqual(data);
  });

  it("encrypts with no URLs yet (pre-upload) and validates once URLs are filled", async () => {
    // The real submit flow encrypts BEFORE upload, so URLs are unknown here.
    // This must NOT throw (regression: the https-only tightening previously made
    // the placeholder URL fail validation, breaking every intro submission).
    const data = crypto.getRandomValues(new Uint8Array(512));
    const { descriptor } = await encryptMedia({
      kind: "intro",
      data,
      mime: "video/webm",
      duration: 5,
      urls: [],
    });
    expect(descriptor.url).toEqual([]);
    // A draft with no URLs is not yet a valid finalized descriptor…
    expect(() => mediaDescriptorSchema.parse(descriptor)).toThrow();
    // …but once the caller fills real https URLs it validates.
    const finalized = mediaDescriptorSchema.parse({ ...descriptor, url: [sampleUrl] });
    expect(finalized.url).toEqual([sampleUrl]);
    // A non-https URL is still rejected (C3 SSRF guard intact).
    expect(() => mediaDescriptorSchema.parse({ ...descriptor, url: ["about:blank"] })).toThrow();
  });

  it("rejects a ciphertext whose hash does not match x", async () => {
    const { ciphertext, descriptor } = await encryptMedia({
      kind: "intro",
      data: new Uint8Array([1, 2, 3]),
      mime: "video/webm",
      duration: 3,
      urls: [sampleUrl],
    });
    ciphertext[0]! ^= 0xff;
    await expect(decryptMedia(descriptor, ciphertext)).rejects.toThrow(/x/);
  });

  it("fresh copy re-keys into a different blob hash (spec §6.2)", async () => {
    const data = crypto.getRandomValues(new Uint8Array(1024));
    const orig = await encryptMedia({
      kind: "intro",
      data,
      mime: "video/webm",
      duration: 7,
      urls: [sampleUrl],
    });
    const fresh = await freshCopy(orig.descriptor, orig.ciphertext, [
      "https://other.example/x.bin",
    ]);
    // Same plaintext, different ciphertext hash — no cross-event blob linkage.
    expect(fresh.descriptor.ox).toBe(orig.descriptor.ox);
    expect(fresh.descriptor.x).not.toBe(orig.descriptor.x);
    const back = await decryptMedia(fresh.descriptor, fresh.ciphertext);
    expect(back).toEqual(data);
  });
});
