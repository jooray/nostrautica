import { describe, it, expect } from "vitest";
import { icsUtc, icsEscape, foldLine, buildIcs, icsFilename } from "./ics.js";

describe("ics", () => {
  it("formats Unix seconds as an RFC 5545 UTC stamp", () => {
    // 2021-11-14T22:13:20Z
    expect(icsUtc(1_636_927_200)).toBe("20211114T220000Z");
    expect(icsUtc(0)).toBe("19700101T000000Z");
  });

  it("escapes TEXT special characters", () => {
    expect(icsEscape("a, b; c\\ d\ne")).toBe("a\\, b\\; c\\\\ d\\ne");
  });

  it("folds long lines at 75 octets with CRLF+space continuation", () => {
    const folded = foldLine("X".repeat(200));
    const segs = folded.split("\r\n");
    expect(segs[0].length).toBe(75);
    expect(segs[1].startsWith(" ")).toBe(true);
    // Rejoining without the fold markers restores the original.
    expect(segs.map((s, i) => (i === 0 ? s : s.slice(1))).join("")).toBe("X".repeat(200));
  });

  it("builds a valid single-event VCALENDAR", () => {
    const ics = buildIcs(
      {
        uid: "31600:pk:d",
        title: "Cypherpunk Meetup",
        description: "Bring a laptop",
        location: "Bratislava",
        start: 1_700_000_000,
        end: 1_700_007_200,
        url: "https://example.com/e/abc",
      },
      1_699_000_000_000,
    );
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:31600:pk:d");
    expect(ics).toContain("SUMMARY:Cypherpunk Meetup");
    expect(ics).toContain("DTSTART:20231114T221320Z");
    expect(ics).toContain("DTEND:20231115T001320Z"); // start + 7200s = +2h
    expect(ics).toContain("LOCATION:Bratislava");
    expect(ics).toContain("URL:https://example.com/e/abc");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // Uses CRLF line endings.
    expect(ics).toContain("\r\n");
  });

  it("defaults a 2-hour block when no end is given", () => {
    const ics = buildIcs({ title: "T", start: 1_700_000_000 }, 0);
    expect(ics).toContain("DTSTART:20231114T221320Z");
    expect(ics).toContain("DTEND:20231115T001320Z"); // +2h
  });

  it("derives a filesystem-safe filename", () => {
    expect(icsFilename("Cypherpunk Meetup!")).toBe("cypherpunk-meetup.ics");
    expect(icsFilename("   ")).toBe("event.ics");
  });
});
