import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KIND_BLOSSOM_SERVERS } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { DEFAULT_BLOSSOM_SERVERS } from "$lib/nostr/relays.js";

const { fetchEvents, uploadAndMirror } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  uploadAndMirror: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/blossom/client.js", async (orig) => ({
  ...(await orig()) as Record<string, unknown>,
  uploadAndMirror,
}));

import { uploadPublicImage, prepareAvatarImage, externalImageUrl, AVATAR_SIZE } from "./image.js";

const signer = {
  method: "local" as const,
  getPublicKey: async () => "a".repeat(64),
} as unknown as AppSigner;

describe("uploadPublicImage (unencrypted)", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    uploadAndMirror.mockReset();
    uploadAndMirror.mockResolvedValue({ urls: ["https://wherever.example/x"], sha256: "x", primary: "https://wherever.example/x" });
  });

  it("includes the user's kind-10063 servers ahead of the app defaults", async () => {
    fetchEvents.mockResolvedValue([
      { kind: KIND_BLOSSOM_SERVERS, created_at: 1, tags: [["server", "https://user-pinned.example"]], content: "" },
    ]);
    const blob = new Blob(["x"], { type: "image/jpeg" });

    await uploadPublicImage(signer, blob, ["https://event-configured.example"]);

    expect(fetchEvents).toHaveBeenCalledWith({ kinds: [KIND_BLOSSOM_SERVERS], authors: ["a".repeat(64)] });
    const servers = uploadAndMirror.mock.calls[0][1];
    expect(servers).toEqual([
      "https://event-configured.example",
      "https://user-pinned.example",
      ...DEFAULT_BLOSSOM_SERVERS,
    ]);
  });

  it("falls back to event servers + defaults when the user has no list", async () => {
    fetchEvents.mockResolvedValue([]);
    const blob = new Blob(["x"], { type: "image/jpeg" });

    await uploadPublicImage(signer, blob, ["https://event-configured.example"]);

    const servers = uploadAndMirror.mock.calls[0][1];
    expect(servers).toEqual(["https://event-configured.example", ...DEFAULT_BLOSSOM_SERVERS]);
  });

  it("drops non-https servers from every source (audit APPR-8)", async () => {
    fetchEvents.mockResolvedValue([
      {
        kind: KIND_BLOSSOM_SERVERS,
        created_at: 1,
        tags: [
          ["server", "http://insecure-user.example"],
          ["server", "https://user-pinned.example"],
        ],
        content: "",
      },
    ]);
    const blob = new Blob(["x"], { type: "image/jpeg" });

    await uploadPublicImage(signer, blob, ["http://insecure-event.example", "https://event-configured.example"]);

    const servers = uploadAndMirror.mock.calls[0][1];
    expect(servers).toEqual([
      "https://event-configured.example",
      "https://user-pinned.example",
      ...DEFAULT_BLOSSOM_SERVERS,
    ]);
  });
});

describe("prepareAvatarImage (audit APPR-3)", () => {
  // The test env has no DOM canvas — stub the two browser seams the helper uses.
  function stubCanvas(opts: { toBlobResult?: Blob | null } = {}) {
    const draws: unknown[][] = [];
    const encodes: { type?: string; quality?: number }[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4000, height: 2000, close: () => {} })),
    );
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (...args: unknown[]) => draws.push(args),
        }),
        toBlob: (cb: (b: Blob | null) => void, type?: string, quality?: number) => {
          encodes.push({ type, quality });
          cb(opts.toBlobResult === undefined ? new Blob(["jpg"], { type: "image/jpeg" }) : opts.toBlobResult);
        },
      }),
    });
    return { draws, encodes };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-encodes to a square JPEG at AVATAR_SIZE (canvas pixels carry no EXIF)", async () => {
    const { draws, encodes } = stubCanvas();
    const raw = new Blob(["raw-camera-original-with-exif"], { type: "image/jpeg" });

    const out = await prepareAvatarImage(raw);

    // Encoded as JPEG (never the raw file object), sized to the avatar square.
    expect(out).not.toBe(raw);
    expect(out.type).toBe("image/jpeg");
    expect(encodes[0]).toEqual({ type: "image/jpeg", quality: 0.9 });
    // Cover-crop math on the 4000x2000 source: center square 2000x2000.
    expect(draws[0]).toEqual([
      expect.anything(),
      1000, // sx — centered horizontally
      0,
      2000,
      2000,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    ]);
  });

  it("FAILS CLOSED on an undecodable image — never returns the raw file", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("undecodable");
      }),
    );
    const raw = new Blob(["not-an-image"], { type: "image/jpeg" });

    await expect(prepareAvatarImage(raw)).rejects.toThrow(/couldn't be read/);
  });

  it("FAILS CLOSED when the canvas encode yields nothing", async () => {
    stubCanvas({ toBlobResult: null });
    const raw = new Blob(["x"], { type: "image/png" });

    await expect(prepareAvatarImage(raw)).rejects.toThrow(/couldn't be processed/);
  });
});

describe("externalImageUrl (paste-a-URL instead of uploading)", () => {
  it("accepts and normalizes an https URL, trimming stray whitespace", () => {
    expect(externalImageUrl("  https://cdn.example/banner.png  ")).toBe(
      "https://cdn.example/banner.png",
    );
    expect(externalImageUrl("https://cdn.example/a.jpg?v=2")).toBe("https://cdn.example/a.jpg?v=2");
  });

  it("rejects anything that isn't https — the tags are public and mixed content breaks", () => {
    expect(externalImageUrl("http://cdn.example/banner.png")).toBeNull();
    expect(externalImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(externalImageUrl("javascript:alert(1)")).toBeNull();
    expect(externalImageUrl("cdn.example/banner.png")).toBeNull();
    expect(externalImageUrl("")).toBeNull();
  });

  it("rejects embedded credentials — the icon/banner tags are world-readable", () => {
    expect(externalImageUrl("https://user:pass@cdn.example/banner.png")).toBeNull();
    expect(externalImageUrl("https://user@cdn.example/banner.png")).toBeNull();
  });
});
