import { describe, it, expect } from "vitest";
import {
  buildPersonDetail,
  introKindOf,
  membershipOf,
  type PersonDetailInput,
} from "./admin-person-detail.js";

const base: PersonDetailInput = {
  role: "attendee",
  revoked: false,
  inRoster: true,
  intakeAvailable: true,
  pending: false,
  statuses: [],
  talks: [],
};

describe("admin-person-detail", () => {
  it("classifies the intro medium", () => {
    expect(introKindOf({ media: [{ kind: "intro", m: "video/webm" } as never] })).toBe("video");
    expect(introKindOf({ media: [{ kind: "intro", m: "audio/webm" } as never] })).toBe("audio");
    expect(introKindOf({ introText: "hello" })).toBe("text");
    expect(introKindOf({})).toBe("none");
  });

  it("resolves membership with revoke/review/roster precedence", () => {
    expect(membershipOf({ ...base, revoked: true })).toBe("revoked");
    expect(membershipOf({ ...base, reviewState: "rejected" })).toBe("rejected");
    expect(membershipOf({ ...base, reviewState: "deferred" })).toBe("deferred");
    expect(membershipOf({ ...base, inRoster: true })).toBe("approved");
    expect(membershipOf({ ...base, inRoster: false, pending: true })).toBe("pending");
  });

  it("builds a newest-first timeline from statuses and talks", () => {
    const { timeline, provenance } = buildPersonDetail({
      ...base,
      introText: "hi",
      statuses: [
        { v: 2, a: "c", pubkey: "p", stage: "process_attendee", state: "poison", at: 100 } as never,
        { v: 2, a: "c", pubkey: "p", stage: "process_attendee", state: "cleared", at: 300 } as never,
      ],
      talks: [{ title: "My Talk", status: "published", at: 200 }],
    });
    expect(provenance.membership).toBe("approved");
    expect(provenance.introKind).toBe("text");
    // Sorted newest first: cleared(300), talk(200), poison(100).
    expect(timeline.map((e) => e.at)).toEqual([300, 200, 100]);
    expect(timeline[0]).toMatchObject({ kind: "status", tone: "ok", labelKey: "admin.person.event.recovered" });
    expect(timeline[1]).toMatchObject({ kind: "talk", tone: "ok", detail: "My Talk" });
    expect(timeline[2]).toMatchObject({ kind: "status", tone: "warn" });
  });

  it("ignores status events with no state", () => {
    const { timeline } = buildPersonDetail({
      ...base,
      statuses: [{ v: 2, a: "c", pubkey: "p", at: 10 } as never],
    });
    expect(timeline).toHaveLength(0);
  });

  it("marks a rejected talk as a warning", () => {
    const { timeline } = buildPersonDetail({
      ...base,
      talks: [{ title: "Rejected One", status: "rejected" }],
    });
    expect(timeline[0]).toMatchObject({ tone: "warn", labelKey: "admin.person.talk.rejected" });
  });
});
