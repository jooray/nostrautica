import { describe, it, expect } from "vitest";
import { overallHealth, type HealthSnapshot } from "./connectivity.svelte.js";

const base: HealthSnapshot = {
  internet: true,
  relay: "connected",
  outboxPending: 0,
  coordinator: "ok",
};

describe("connectivity overallHealth", () => {
  it("reports offline when the browser has no internet", () => {
    expect(overallHealth({ ...base, internet: false })).toBe("offline");
  });

  it("reports relay-blocked when online but a real relay attempt FAILED (the WiFi lie)", () => {
    expect(overallHealth({ ...base, relay: "failed" })).toBe("relay-blocked");
  });

  it("reports syncing when connected but the outbox still has queued events", () => {
    expect(overallHealth({ ...base, outboxPending: 3 })).toBe("syncing");
  });

  it("reports online when everything is up and drained", () => {
    expect(overallHealth(base)).toBe("online");
  });

  it("offline takes precedence over a failed relay/outbox", () => {
    expect(
      overallHealth({ internet: false, relay: "failed", outboxPending: 5, coordinator: "none" }),
    ).toBe("offline");
  });

  // Item 5: the banner must NOT fire before a relay connection has been attempted.
  // On the logged-out home page nothing calls connectNdk, so relay stays "idle" —
  // "relay-blocked" then would be a false positive (seen live on production).
  it("stays quiet (connecting) when no relay attempt has been made yet (idle)", () => {
    expect(overallHealth({ ...base, relay: "idle" })).toBe("connecting");
  });

  it("stays quiet (connecting) while a relay attempt is still in flight", () => {
    expect(overallHealth({ ...base, relay: "connecting" })).toBe("connecting");
  });

  it("outbox does not force a banner while still merely connecting (no false blocked)", () => {
    // A queued outbox with no confirmed relay yet must not read as blocked; it's
    // simply not connected yet. Only a FAILED attempt earns the banner.
    expect(overallHealth({ ...base, relay: "connecting", outboxPending: 2 })).toBe("connecting");
  });
});
