/**
 * Pending-talk moderation-queue logic (spec F2.3). The organizer unwraps 21609
 * talk submissions from E_inbox; `dedupePendingTalks` collapses them to the latest
 * per (speaker, talk_d) and hides any already published as a 31610 at the
 * same-or-newer revision. This is the pure core of `fetchPendingTalks`.
 */
import { describe, it, expect } from "vitest";
import { dedupePendingTalks, type RawTalkSubmission } from "./talks.js";
import type { MediaDescriptor, TalkSubmissionContent } from "@nostrautica/protocol";

const media = { kind: "talk", x: "a".repeat(64) } as unknown as MediaDescriptor;

function sub(
  pubkey: string,
  talkD: string,
  rev: number,
  at: number,
  title = "Talk",
): RawTalkSubmission {
  const content = {
    v: 2,
    a: "31600:host:conf",
    talk_d: talkD,
    title,
    description: "",
    speakers: [],
    media,
    revision: rev,
  } as unknown as TalkSubmissionContent;
  return { pubkey, content, rumorCreatedAt: at };
}

describe("dedupePendingTalks", () => {
  it("keeps only the latest submission per (speaker, talk_d)", () => {
    const out = dedupePendingTalks(
      [
        sub("alice", "t1", 0, 100, "old"),
        sub("alice", "t1", 1, 200, "new"),
      ],
      new Map(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("new");
    expect(out[0].revision).toBe(1);
  });

  it("treats different speakers and different talk_ds as distinct", () => {
    const out = dedupePendingTalks(
      [
        sub("alice", "t1", 0, 100),
        sub("bob", "t1", 0, 110),
        sub("alice", "t2", 0, 120),
      ],
      new Map(),
    );
    expect(out).toHaveLength(3);
  });

  it("excludes talks already published at the same-or-newer revision", () => {
    const published = new Map([["alice:t1", 0]]);
    const out = dedupePendingTalks([sub("alice", "t1", 0, 100)], published);
    expect(out).toHaveLength(0);
  });

  it("re-surfaces an edit whose revision exceeds the published one", () => {
    const published = new Map([["alice:t1", 0]]);
    const out = dedupePendingTalks([sub("alice", "t1", 1, 300)], published);
    expect(out).toHaveLength(1);
    expect(out[0].revision).toBe(1);
  });

  it("orders the queue oldest-submitted first", () => {
    const out = dedupePendingTalks(
      [
        sub("bob", "t1", 0, 300),
        sub("alice", "t1", 0, 100),
        sub("carol", "t1", 0, 200),
      ],
      new Map(),
    );
    expect(out.map((t) => t.pubkey)).toEqual(["alice", "carol", "bob"]);
  });

  it("does not exclude when a different talk is published", () => {
    const published = new Map([["alice:other", 5]]);
    const out = dedupePendingTalks([sub("alice", "t1", 0, 100)], published);
    expect(out).toHaveLength(1);
  });
});
