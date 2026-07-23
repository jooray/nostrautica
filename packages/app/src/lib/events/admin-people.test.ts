import { describe, it, expect } from "vitest";
import {
  mergePending,
  visiblePending,
  buildApprovedPeople,
  summarizeBulk,
  filterPeople,
  type BulkItem,
  type FilterablePerson,
} from "./admin-people.js";
import type { PendingRequest } from "./organizer.js";
import type { RosterContent, DirectoryEntryContent, CoordinatorStatusContent } from "@nostrautica/protocol";

const pk = (n: string) => n.repeat(64).slice(0, 64);

function req(p: string, at: number, over: Partial<PendingRequest> = {}): PendingRequest {
  return {
    attendeePubkey: p,
    name: `name-${p.slice(0, 4)}`,
    message: "",
    rsvpPublic: false,
    rumorCreatedAt: at,
    ...over,
  };
}

function roster(pubkeys: string[]): RosterContent {
  return {
    v: 2,
    eck_current: 1,
    attendees: pubkeys.map((p) => ({ pubkey: p, d: `d-${p.slice(0, 4)}`, role: "attendee" as const })),
  };
}

describe("mergePending (UX-A2: merge-don't-replace)", () => {
  it("§12.16 a partial refresh omitting a known request does not remove it", () => {
    const known = [req(pk("a"), 100), req(pk("b"), 200)];
    // A transient relay result returns only one of the two known requests.
    const fresh = [req(pk("a"), 100)];
    const merged = mergePending(known, fresh);
    expect(merged.map((r) => r.attendeePubkey).sort()).toEqual([pk("a"), pk("b")].sort());
  });

  it("folds a newer submission into an existing request", () => {
    const known = [req(pk("a"), 100, { name: "old" })];
    const fresh = [req(pk("a"), 150, { name: "new" })];
    expect(mergePending(known, fresh)[0].name).toBe("new");
  });

  it("keeps the newer of two on an out-of-order (older) refetch", () => {
    const known = [req(pk("a"), 200, { name: "new" })];
    const fresh = [req(pk("a"), 100, { name: "old" })];
    expect(mergePending(known, fresh)[0].name).toBe("new");
  });

  it("adds a genuinely new request from the fresh scan", () => {
    const merged = mergePending([req(pk("a"), 100)], [req(pk("a"), 100), req(pk("c"), 300)]);
    expect(merged).toHaveLength(2);
    expect(merged[merged.length - 1].attendeePubkey).toBe(pk("c"));
  });
});

describe("visiblePending (confirmed-transition removal)", () => {
  it("drops approved + revoked, keeps the rest", () => {
    const known = [req(pk("a"), 1), req(pk("b"), 2), req(pk("c"), 3)];
    const approved = new Set([pk("a")]);
    const revoked = new Set([pk("b")]);
    const visible = visiblePending(known, (p) => approved.has(p), revoked);
    expect(visible.map((r) => r.attendeePubkey)).toEqual([pk("c")]);
  });

  it("UX-A7: drops locally rejected requests too", () => {
    const known = [req(pk("a"), 1), req(pk("b"), 2)];
    const rejected = new Set([pk("a")]);
    const visible = visiblePending(known, () => false, new Set(), rejected);
    expect(visible.map((r) => r.attendeePubkey)).toEqual([pk("b")]);
  });
});

describe("buildApprovedPeople (UX-A1: roster is the source of truth)", () => {
  it("§12.15 a roster member with no recent gift-wraps is still listed with intake unavailable", () => {
    const people = buildApprovedPeople({
      roster: roster([pk("a")]),
      sessionApproved: new Set(),
      revoked: new Set(),
      known: [], // their join request aged out of the backfill window
      directory: [],
    });
    expect(people).toHaveLength(1);
    expect(people[0].pubkey).toBe(pk("a"));
    expect(people[0].intakeAvailable).toBe(false);
    expect(people[0].inRoster).toBe(true);
    expect(people[0].revoked).toBe(false);
  });

  it("enriches a roster member from a recent pending request", () => {
    const people = buildApprovedPeople({
      roster: roster([pk("a")]),
      sessionApproved: new Set(),
      revoked: new Set(),
      known: [req(pk("a"), 10, { name: "Ada", introText: "hi there" })],
    });
    expect(people[0].intakeAvailable).toBe(true);
    expect(people[0].name).toBe("Ada");
    expect(people[0].hasIntro).toBe(true);
  });

  it("prefers directory entry data over the raw pending request", () => {
    const dir: DirectoryEntryContent = {
      v: 2,
      pubkey: pk("a"),
      name: "Directory Name",
      profile: { about: "", skills: ["rust"], looking_for: "", links: [] },
      media: [],
      updated_at: 5,
    };
    const people = buildApprovedPeople({
      roster: roster([pk("a")]),
      sessionApproved: new Set(),
      revoked: new Set(),
      known: [req(pk("a"), 10, { name: "Join Name" })],
      directory: [dir],
    });
    expect(people[0].name).toBe("Directory Name");
    expect(people[0].profile?.skills).toEqual(["rust"]);
  });

  it("includes a just-approved attendee not yet in the roster", () => {
    const people = buildApprovedPeople({
      roster: roster([]),
      sessionApproved: new Set([pk("a")]),
      revoked: new Set(),
      known: [req(pk("a"), 10)],
    });
    expect(people.map((p) => p.pubkey)).toContain(pk("a"));
    expect(people[0].inRoster).toBe(false);
  });

  it("keeps a just-revoked person's card marked revoked", () => {
    const people = buildApprovedPeople({
      roster: roster([]),
      sessionApproved: new Set(),
      revoked: new Set([pk("a")]),
      known: [req(pk("a"), 10)],
    });
    expect(people[0].revoked).toBe(true);
  });

  it("marks a person failed when a poison status references them", () => {
    const statuses: CoordinatorStatusContent[] = [
      { v: 2, a: "31923:eid:ev", pubkey: pk("a"), stage: "process_attendee", state: "poison", at: 9 },
    ];
    const people = buildApprovedPeople({
      roster: roster([pk("a")]),
      sessionApproved: new Set(),
      revoked: new Set(),
      known: [req(pk("a"), 10)],
      statuses,
    });
    expect(people[0].op).toBe("failed");
  });
});

describe("summarizeBulk (UX-A4)", () => {
  it("tallies confirmed vs failed and reports done", () => {
    const items: BulkItem[] = [
      { pubkey: pk("a"), state: "confirmed" },
      { pubkey: pk("b"), state: "failed", error: "relay down" },
      { pubkey: pk("c"), state: "confirmed" },
    ];
    expect(summarizeBulk(items)).toEqual({ approved: 2, needRetry: 1, done: true });
  });

  it("reports not-done while work is still queued/publishing", () => {
    const items: BulkItem[] = [
      { pubkey: pk("a"), state: "confirmed" },
      { pubkey: pk("b"), state: "publishing" },
    ];
    expect(summarizeBulk(items).done).toBe(false);
  });
});

describe("filterPeople (UX-A6)", () => {
  const people: FilterablePerson[] = [
    { pubkey: pk("a"), name: "Alice", approved: true, hasIntro: true, op: "ok", hasTalk: false },
    { pubkey: pk("b"), name: "Bob", approved: false, hasIntro: false, op: "ok", hasTalk: false },
    { pubkey: pk("c"), name: "Carol", approved: true, hasIntro: false, op: "failed", hasTalk: true },
  ];

  it("filters by approval state", () => {
    expect(filterPeople(people, "pending", "").map((p) => p.name)).toEqual(["Bob"]);
    expect(filterPeople(people, "approved", "").map((p) => p.name).sort()).toEqual(["Alice", "Carol"]);
  });

  it("filters approved-without-intro and failed", () => {
    expect(filterPeople(people, "no-intro", "").map((p) => p.name)).toEqual(["Carol"]);
    expect(filterPeople(people, "failed", "").map((p) => p.name)).toEqual(["Carol"]);
    expect(filterPeople(people, "talk", "").map((p) => p.name)).toEqual(["Carol"]);
  });

  it("matches a name/pubkey substring query", () => {
    expect(filterPeople(people, "all", "ali").map((p) => p.name)).toEqual(["Alice"]);
    expect(filterPeople(people, "all", pk("b").slice(0, 6)).map((p) => p.name)).toEqual(["Bob"]);
  });
});
