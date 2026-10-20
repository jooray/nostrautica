/**
 * A brand-new post must not render "(edited)" (manual e2e NOTE-5).
 *
 * PostCard shows the marker when `created_at > published_at`. Both publishers
 * took `published_at` from a clock read BEFORE publishMonotonic's relay
 * round-trip, so the created_at it then reserved was a second or more later and
 * every fresh post, public or members-only, came out "edited". The mock below
 * reserves a created_at a few seconds past the clock, as a slow relay read does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools/pure";
import {
  bytesToBase64,
  bytesToHex,
  decryptMembersPost,
  generateEck,
  makeCoordinate,
} from "@nostrautica/protocol";

const { publishMonotonic, loadEventKeys } = vi.hoisted(() => ({
  publishMonotonic: vi.fn(),
  loadEventKeys: vi.fn(),
}));
vi.mock("$lib/nostr/monotonic.js", () => ({ publishMonotonic }));
vi.mock("$lib/nostr/publish-queue.js", () => ({
  publishOrQueue: vi.fn(),
  toOutcome: (b: boolean) => (b ? "published" : "queued"),
}));
vi.mock("./keystore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./keystore.js")>()),
  loadEventKeys,
}));

import { publishMembersPost } from "./posts.js";
import { publishEventUpdate } from "./updates.js";
import type { EventContext } from "./event-context.js";

const eidSk = generateSecretKey();
const eid = getPublicKey(eidSk);
const eck = generateEck();
const ctx = {
  coordinate: makeCoordinate(eid, "conf"),
  config: { eidPubkey: eid, relays: ["wss://relay.example"] },
} as unknown as EventContext;

let signed: VerifiedEvent[] = [];
const LATER = Math.floor(Date.now() / 1000) + 5;

beforeEach(() => {
  signed = [];
  publishMonotonic.mockReset().mockImplementation(
    async (input: { sign: (at: number) => VerifiedEvent | Promise<VerifiedEvent> }) => {
      signed.push(await input.sign(LATER));
      return { published: true, createdAt: LATER };
    },
  );
  loadEventKeys.mockReset().mockResolvedValue({
    role: "organizer",
    eidNsecHex: bytesToHex(eidSk),
    eck: [{ id: 1, key: bytesToBase64(eck) }],
  });
});

describe("published_at on a new post (NOTE-5)", () => {
  it("members-only: published_at is the created_at it was signed with", async () => {
    const { post } = await publishMembersPost(ctx, { title: "Hi", content: "body" });
    expect(post.publishedAt).toBe(LATER);
    expect(post.editedAt).toBe(post.publishedAt);
    expect(decryptMembersPost(eck, signed[0]!.content).published_at).toBe(LATER);
  });

  it("public update: published_at is the created_at it was signed with", async () => {
    const { update } = await publishEventUpdate(ctx, { title: "Hi", content: "body" });
    expect(update.publishedAt).toBe(LATER);
    expect(update.editedAt).toBe(update.publishedAt);
    expect(signed[0]!.tags).toContainEqual(["published_at", String(LATER)]);
  });

  it("an edit keeps the original published_at", async () => {
    const { post } = await publishMembersPost(ctx, { d: "p1", title: "Hi", content: "v2", publishedAt: 100 });
    const { update } = await publishEventUpdate(ctx, { d: "u1", title: "Hi", content: "v2", publishedAt: 100 });
    expect(post.publishedAt).toBe(100);
    expect(update.publishedAt).toBe(100);
    expect(decryptMembersPost(eck, signed[0]!.content).published_at).toBe(100);
    expect(signed[1]!.tags).toContainEqual(["published_at", "100"]);
  });
});
