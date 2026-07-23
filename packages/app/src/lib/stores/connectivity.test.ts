import { describe, it, expect } from "vitest";
import { overallHealth, type HealthSnapshot } from "./connectivity.svelte.js";

const base: HealthSnapshot = {
  internet: true,
  relayConnected: true,
  outboxPending: 0,
  coordinator: "ok",
};

describe("connectivity overallHealth", () => {
  it("reports offline when the browser has no internet", () => {
    expect(overallHealth({ ...base, internet: false })).toBe("offline");
  });

  it("reports relay-blocked when online but no relay is connected (the WiFi lie)", () => {
    expect(overallHealth({ ...base, relayConnected: false })).toBe("relay-blocked");
  });

  it("reports syncing when connected but the outbox still has queued events", () => {
    expect(overallHealth({ ...base, outboxPending: 3 })).toBe("syncing");
  });

  it("reports online when everything is up and drained", () => {
    expect(overallHealth(base)).toBe("online");
  });

  it("offline takes precedence over a stale relay/outbox", () => {
    expect(
      overallHealth({ internet: false, relayConnected: false, outboxPending: 5, coordinator: "none" }),
    ).toBe("offline");
  });
});
