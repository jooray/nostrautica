import { describe, it, expect } from "vitest";
import { foldChatTimeline } from "./timeline.js";
import type { ChatMessage } from "./messages.js";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

let seq = 0;
function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "pubkey">): ChatMessage {
  seq++;
  return {
    id: over.id ?? `id${String(seq).padStart(4, "0")}`,
    kind: 9,
    content: "",
    createdAt: 1000 + seq,
    tags: [],
    ...over,
  };
}
const text = (pubkey: string, content: string, id?: string) => msg({ pubkey, content, id });
const react = (pubkey: string, target: string, emoji: string, id?: string) =>
  msg({ pubkey, kind: 7, content: emoji, tags: [["e", target]], id });
const edit = (pubkey: string, target: string, content: string, createdAt?: number) =>
  msg({ pubkey, kind: 1009, content, tags: [["e", target]], ...(createdAt ? { createdAt } : {}) });
const del = (pubkey: string, ...ids: string[]) => msg({ pubkey, kind: 5, tags: ids.map((i) => ["e", i]) });

describe("foldChatTimeline", () => {
  it("renders only kind 9 lines; modifiers never become bubbles of their own", () => {
    const m = text(ALICE, "hi", "m1");
    const out = foldChatTimeline([m, react(BOB, "m1", "👍"), edit(ALICE, "m1", "hello")], ALICE);
    expect(out.map((x) => x.id)).toEqual(["m1"]);
  });

  it("aggregates reactions per emoji, one count per sender, and marks our own", () => {
    const out = foldChatTimeline(
      [
        text(ALICE, "hi", "m1"),
        react(BOB, "m1", "👍", "r1"),
        react(CAROL, "m1", "👍", "r2"),
        react(BOB, "m1", "👍", "r3"), // the same sender again: still one
        react(ALICE, "m1", "❤️", "r4"),
      ],
      ALICE,
    );
    expect(out[0]!.reactions).toEqual([
      { emoji: "👍", count: 2, mine: false, ownIds: [] },
      { emoji: "❤️", count: 1, mine: true, ownIds: ["r4"] },
    ]);
  });

  it("folds a reaction that arrived before its target", () => {
    const out = foldChatTimeline([react(BOB, "m1", "🎉"), text(ALICE, "late", "m1")], ALICE);
    expect(out[0]!.reactions[0]).toMatchObject({ emoji: "🎉", count: 1 });
  });

  it("a kind 5 from the reactor retracts the reaction; one from anyone else does not", () => {
    const out = foldChatTimeline(
      [
        text(ALICE, "hi", "m1"),
        react(BOB, "m1", "👍", "r1"),
        react(CAROL, "m1", "👀", "r2"),
        del(BOB, "r1"),
        del(BOB, "r2"), // not Bob's to retract
      ],
      BOB,
    );
    expect(out[0]!.reactions).toEqual([{ emoji: "👀", count: 1, mine: false, ownIds: [] }]);
  });

  it("ignores empty and oversize reactions", () => {
    const out = foldChatTimeline(
      [text(ALICE, "hi", "m1"), react(BOB, "m1", ""), react(BOB, "m1", "x".repeat(65))],
      ALICE,
    );
    expect(out[0]!.reactions).toEqual([]);
  });

  it("shows the author's latest edit, by created_at then id, and labels it edited", () => {
    const out = foldChatTimeline(
      [
        text(ALICE, "first", "m1"),
        edit(ALICE, "m1", "third", 3000),
        edit(ALICE, "m1", "second", 2000),
      ],
      BOB,
    );
    expect(out[0]).toMatchObject({ content: "third", originalContent: "first", edited: true });
  });

  it("refuses an edit from anyone but the author (another device of theirs included)", () => {
    const out = foldChatTimeline([text(ALICE, "mine", "m1"), edit(BOB, "m1", "hijacked")], ALICE);
    expect(out[0]).toMatchObject({ content: "mine", edited: false });
  });

  it("refuses an edit naming more than one target, as MDK does", () => {
    const two = msg({ pubkey: ALICE, kind: 1009, content: "x", tags: [["e", "m1"], ["e", "m2"]] });
    const out = foldChatTimeline([text(ALICE, "a", "m1"), text(ALICE, "b", "m2"), two], ALICE);
    expect(out.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("a retracted edit falls back to the previous version", () => {
    const e1 = edit(ALICE, "m1", "v2", 2000);
    const e2 = edit(ALICE, "m1", "v3", 3000);
    const out = foldChatTimeline([text(ALICE, "v1", "m1"), e1, e2, del(ALICE, e2.id)], ALICE);
    expect(out[0]).toMatchObject({ content: "v2", edited: true });
  });

  it("the author's delete tombstones the message and drops its edit and reactions", () => {
    const out = foldChatTimeline(
      [text(ALICE, "oops", "m1"), edit(ALICE, "m1", "oops2"), react(BOB, "m1", "😂"), del(ALICE, "m1")],
      ALICE,
    );
    expect(out[0]).toMatchObject({ deleted: true, content: "", edited: false, reactions: [] });
  });

  it("refuses a delete from anyone but the author", () => {
    const out = foldChatTimeline([text(ALICE, "stays", "m1"), del(BOB, "m1")], ALICE);
    expect(out[0]).toMatchObject({ deleted: false, content: "stays" });
  });

  it("is order-independent", () => {
    const all = [
      text(ALICE, "hi", "m1"),
      edit(ALICE, "m1", "hello", 5000),
      react(BOB, "m1", "👍", "r1"),
      react(CAROL, "m1", "👍", "r2"),
      del(CAROL, "r2"),
      text(BOB, "gone", "m2"),
      del(BOB, "m2"),
    ];
    const a = foldChatTimeline(all, BOB);
    const b = foldChatTimeline([...all].reverse(), BOB);
    const byId = (xs: typeof a) => Object.fromEntries(xs.map((x) => [x.id, x]));
    expect(byId(b)).toEqual(byId(a));
    expect(a.find((x) => x.id === "m1")).toMatchObject({
      content: "hello",
      reactions: [{ emoji: "👍", count: 1, mine: true, ownIds: ["r1"] }],
    });
  });
});
