import { describe, it, expect } from "vitest";
import { eventPhase, daysUntil, directionsUrl, formatRange } from "./logistics.js";

describe("logistics", () => {
  const start = 1_700_000_000;
  const end = start + 3600;

  it("computes the happening-now phase", () => {
    expect(eventPhase(start, end, start - 10)).toBe("upcoming");
    expect(eventPhase(start, end, start)).toBe("happening");
    expect(eventPhase(start, end, start + 1800)).toBe("happening");
    expect(eventPhase(start, end, end + 1)).toBe("ended");
    expect(eventPhase(undefined, end, start)).toBe("unknown");
  });

  it("uses a default duration when no end is set", () => {
    expect(eventPhase(start, undefined, start + 3600)).toBe("happening"); // within 2h
    expect(eventPhase(start, undefined, start + 3 * 3600)).toBe("ended"); // past 2h
  });

  it("counts whole days until start", () => {
    expect(daysUntil(start, start - 2 * 86_400)).toBe(2);
    expect(daysUntil(start, start - 1)).toBe(1);
    expect(daysUntil(start, start)).toBeNull();
    expect(daysUntil(undefined, 0)).toBeNull();
  });

  it("builds a directions URL only for a non-empty venue", () => {
    expect(directionsUrl("Main Square, Bratislava")).toContain(
      "openstreetmap.org/search?query=Main%20Square%2C%20Bratislava",
    );
    expect(directionsUrl("  ")).toBeNull();
    expect(directionsUrl(undefined)).toBeNull();
  });

  it("formats a range including a time zone and collapses same-day dates", () => {
    const single = formatRange(start, undefined, "en-US");
    expect(single).toMatch(/\d/);
    const sameDay = formatRange(start, end, "en-US");
    // Same-day: an en dash separates start datetime from an end time-only.
    expect(sameDay).toContain("–");
    expect(formatRange(undefined, end, "en-US")).toBe("");
  });
});
