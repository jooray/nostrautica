import { describe, it, expect } from "vitest";
import {
  generateEck,
  bytesToBase64,
  encryptMembersPost,
  KIND_LONGFORM,
  KIND_MEMBERS_POST,
  type EckVersion,
} from "@nostrautica/protocol";
import { dedupePostsByD, toEventPost, randomPostD, type RawPostEvent } from "./posts.js";

const EID = "e".repeat(64);

function pub(d: string, created_at: number, title = "t"): RawPostEvent {
  return {
    kind: KIND_LONGFORM,
    pubkey: EID,
    created_at,
    tags: [
      ["d", d],
      ["title", title],
      ["published_at", String(created_at)],
    ],
    content: "body",
  };
}

function enc(
  d: string,
  created_at: number,
  eck: Uint8Array,
  eckId: number,
  overrides: Partial<{ title: string; published_at: number; content: string }> = {},
): RawPostEvent {
  return {
    kind: KIND_MEMBERS_POST,
    pubkey: EID,
    created_at,
    tags: [
      ["d", d],
      ["v", "1"],
      ["eck", String(eckId)],
    ],
    content: encryptMembersPost(eck, {
      v: 1,
      title: overrides.title ?? "secret",
      published_at: overrides.published_at ?? created_at,
      content: overrides.content ?? "members body",
    }),
  };
}

describe("dedupePostsByD", () => {
  it("keeps the highest created_at per d ACROSS BOTH KINDS", () => {
    const eck = generateEck();
    const events = [
      pub("x", 100),
      enc("x", 200, eck, 1), // later 31607 at the same address wins
      pub("y", 300),
      pub("y", 250),
    ];
    const out = dedupePostsByD(events);
    expect(out).toHaveLength(2);
    const x = out.find((e) => e.tags[0][1] === "x")!;
    expect(x.kind).toBe(KIND_MEMBERS_POST);
    expect(x.created_at).toBe(200);
    const y = out.find((e) => e.tags[0][1] === "y")!;
    expect(y.created_at).toBe(300);
  });

  it("keys per author so attendee posts with the same d don't collide", () => {
    const a = { ...pub("dup", 100), pubkey: "1".repeat(64) };
    const b = { ...pub("dup", 90), pubkey: "2".repeat(64) };
    expect(dedupePostsByD([a, b])).toHaveLength(2);
  });
});

describe("toEventPost", () => {
  it("maps a public 30023 with cleartext tags", () => {
    const post = toEventPost(pub("d1", 123, "Hello"), []);
    expect(post).toMatchObject({
      d: "d1",
      membersOnly: false,
      locked: false,
      title: "Hello",
      content: "body",
      publishedAt: 123,
    });
  });

  it("decrypts a 31607 with the version named by its eck tag — not the current", () => {
    const v1 = generateEck();
    const v2 = generateEck();
    const granted: EckVersion[] = [
      { id: 1, key: bytesToBase64(v1) },
      { id: 2, key: bytesToBase64(v2) },
    ];
    // Post encrypted under v1 while v2 is current: must still decrypt via the tag.
    const post = toEventPost(enc("d2", 500, v1, 1, { published_at: 400 }), granted);
    expect(post.locked).toBe(false);
    expect(post.title).toBe("secret");
    expect(post.publishedAt).toBe(400); // preserved from inside the ciphertext
    expect(post.eckVersion).toBe(1);
  });

  it("returns a locked post when the named version isn't granted", () => {
    const v2 = generateEck();
    const grantedOnlyV1: EckVersion[] = [{ id: 1, key: bytesToBase64(generateEck()) }];
    const post = toEventPost(enc("d3", 500, v2, 2), grantedOnlyV1);
    expect(post.locked).toBe(true);
    expect(post.title).toBe("");
    expect(post.content).toBe("");
    expect(post.membersOnly).toBe(true);
  });

  it("returns a locked post when the reader holds no keys at all (visitor)", () => {
    const post = toEventPost(enc("d4", 500, generateEck(), 1), []);
    expect(post.locked).toBe(true);
  });

  it("locks instead of throwing on a garbled ciphertext under the right id", () => {
    const eck = generateEck();
    const wrongKeySameId: EckVersion[] = [{ id: 1, key: bytesToBase64(generateEck()) }];
    const post = toEventPost(enc("d5", 500, eck, 1), wrongKeySameId);
    expect(post.locked).toBe(true);
  });
});

describe("randomPostD", () => {
  it("is 32 lowercase hex chars and unique per call", () => {
    const a = randomPostD();
    const b = randomPostD();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
