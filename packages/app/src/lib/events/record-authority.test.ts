import { describe, it, expect } from "vitest";
import { acceptedRecordAuthors } from "./organizer.js";
import { onlyByAuthors } from "$lib/nostr/verify.js";
import type { EventContext } from "./event-context.js";

const EID = "e".repeat(64);
const COORD = "c".repeat(64);
const STALE = "d".repeat(64);

function ctx(coordinator?: string): EventContext {
  return { config: { eidPubkey: EID, coordinator } } as unknown as EventContext;
}

describe("record-authority pinning (NIP §3.7)", () => {
  it("accepts the current coordinator and E_id, never a formerly assigned one", () => {
    const authors = acceptedRecordAuthors(ctx(COORD));
    expect(authors).toContain(COORD);
    expect(authors).toContain(EID);
    expect(authors).not.toContain(STALE);
  });

  it("with no coordinator, only E_id authors records", () => {
    expect(acceptedRecordAuthors(ctx(undefined))).toEqual([EID]);
  });

  it("onlyByAuthors drops a stale-coordinator record and keeps the current one", () => {
    const events = [
      { id: "1", pubkey: COORD, kind: 31604 },
      { id: "2", pubkey: STALE, kind: 31604 }, // formerly assigned coordinator
      { id: "3", pubkey: EID, kind: 31603 },
    ];
    const kept = onlyByAuthors(events, acceptedRecordAuthors(ctx(COORD)));
    expect(kept.map((e) => e.id)).toEqual(["1", "3"]);
  });

  it("fail-closed: an empty allowlist and a pubkey-less event drop everything", () => {
    expect(onlyByAuthors([{ id: "1", pubkey: COORD }], [])).toEqual([]);
    expect(onlyByAuthors([{ id: "1" }], [COORD])).toEqual([]);
  });
});
