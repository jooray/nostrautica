/**
 * Coordinator status (kind 21606, audit Q12) pure-logic tests. Proves the Admin
 * UI only trusts a poison/health status actually sealed by the configured
 * coordinator, and that keep-latest-per-(stage, attendee) dedupe holds. No relays.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  KIND_COORDINATOR_STATUS,
  KIND_KEY_GRANT,
  type Rumor,
  type CoordinatorStatusContent,
} from "@nostrautica/protocol";
import {
  authenticateCoordinatorStatus,
  dedupeLatestStatuses,
} from "./coordinator-status.js";

const coordinator = getPublicKey(generateSecretKey());
const attacker = getPublicKey(generateSecretKey());

/** A minimal unwrapped rumor; `pubkey` is the (verified) seal author. */
function rumor(pubkey: string, kind = KIND_COORDINATOR_STATUS): Rumor {
  return {
    id: "0".repeat(64),
    pubkey,
    created_at: 1,
    kind,
    tags: [],
    content: "{}",
  };
}

function status(
  over: Partial<CoordinatorStatusContent> = {},
): CoordinatorStatusContent {
  return {
    v: 1,
    a: "31923:eid:evt",
    stage: "process_attendee",
    state: "poison",
    attempts: 3,
    error_category: "transcription_failed",
    retryable: true,
    at: 100,
    ...over,
  };
}

describe("authenticateCoordinatorStatus", () => {
  it("accepts a status sealed by the configured coordinator", () => {
    expect(authenticateCoordinatorStatus(rumor(coordinator), coordinator)).toBe(true);
  });

  it("rejects a 21606 sealed by a non-coordinator key", () => {
    expect(authenticateCoordinatorStatus(rumor(attacker), coordinator)).toBe(false);
  });

  it("rejects a non-status rumor kind even from the coordinator", () => {
    expect(
      authenticateCoordinatorStatus(rumor(coordinator, KIND_KEY_GRANT), coordinator),
    ).toBe(false);
  });

  it("rejects when no coordinator is configured", () => {
    expect(authenticateCoordinatorStatus(rumor(coordinator), undefined)).toBe(false);
  });
});

describe("dedupeLatestStatuses", () => {
  it("keeps the latest status per stage", () => {
    const older = status({ stage: "process_attendee", attempts: 2, at: 100 });
    const newer = status({ stage: "process_attendee", attempts: 5, at: 200 });
    const out = dedupeLatestStatuses([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe(200);
    expect(out[0].attempts).toBe(5);
  });

  it("keeps distinct rows per (stage, attendee)", () => {
    const a = status({ stage: "process_attendee", pubkey: "a".repeat(64) });
    const b = status({ stage: "process_attendee", pubkey: "b".repeat(64) });
    const c = status({ stage: "match_recompute", pubkey: undefined });
    const out = dedupeLatestStatuses([a, b, c]);
    expect(out).toHaveLength(3);
  });

  it("lets a newer cleared status supersede an earlier poison for the same job", () => {
    const poison = status({ state: "poison", at: 100 });
    const cleared = status({ state: "cleared", at: 300 });
    const out = dedupeLatestStatuses([poison, cleared]);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe("cleared");
  });
});
