/**
 * Audit KIMIK31 W-12: Admin replaced its cached coordinator warnings (poisoned
 * attendees, failed stages) with whatever `fetchCoordinatorStatuses` returned,
 * and a read no relay answered returned []. A relay outage then looked exactly
 * like every problem having been resolved.
 */
import { describe, it, expect, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@nostrautica/protocol";

const { fetchEventsRelayOnly } = vi.hoisted(() => ({ fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEventsRelayOnly }));

import { fetchCoordinatorStatuses } from "./coordinator-status.js";
import type { EventContext } from "./event-context.js";

const ctx = {
  coordinate: "31923:" + "e".repeat(64) + ":conf",
  config: { coordinator: getPublicKey(generateSecretKey()), relays: ["wss://r.example"] },
} as unknown as EventContext;
const eid = bytesToHex(generateSecretKey());

describe("fetchCoordinatorStatuses when no relay answered", () => {
  it("throws instead of reporting that there are no problems", async () => {
    fetchEventsRelayOnly.mockImplementationOnce(
      async (_f: unknown, _r: unknown, opts?: { onSettled?: (a: boolean) => void }) => {
        opts?.onSettled?.(false);
        return [];
      },
    );
    await expect(fetchCoordinatorStatuses(ctx, eid)).rejects.toThrow(/No relay answered/);
  });

  it("an answered empty read is still 'no statuses'", async () => {
    fetchEventsRelayOnly.mockImplementationOnce(
      async (_f: unknown, _r: unknown, opts?: { onSettled?: (a: boolean) => void }) => {
        opts?.onSettled?.(true);
        return [];
      },
    );
    await expect(fetchCoordinatorStatuses(ctx, eid)).resolves.toEqual([]);
  });
});
