import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_BLOSSOM_SERVERS } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { DEFAULT_BLOSSOM_SERVERS } from "$lib/nostr/relays.js";

const { fetchEvents, uploadAndMirror } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  uploadAndMirror: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/blossom/client.js", () => ({ uploadAndMirror }));

import { uploadPublicImage } from "./image.js";

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
});
