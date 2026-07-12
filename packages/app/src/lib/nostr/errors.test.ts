import { describe, it, expect } from "vitest";
import { isBenignRelayError } from "./errors.js";

describe("isBenignRelayError", () => {
  it("recognizes expected relay publish rejections", () => {
    for (const m of [
      "rate-limited: you are noting too much",
      "blocked: pubkey not allowed",
      "pow: difficulty 20 required",
      "duplicate: already have this event",
      "Timeout: 2500ms",
      "restricted: not on the allow list",
      "auth-required: this relay requires authentication",
      "Not enough relays received the event (0 published, 1 required)",
    ]) {
      expect(isBenignRelayError(new Error(m)), m).toBe(true);
    }
  });

  it("does NOT swallow genuine app errors", () => {
    for (const m of [
      "Cannot read properties of undefined",
      "invalid nsec",
      "organizer keys not available",
      "ciphertext sha256 mismatch",
    ]) {
      expect(isBenignRelayError(new Error(m)), m).toBe(false);
    }
  });

  it("handles strings and non-errors safely", () => {
    expect(isBenignRelayError("rate-limited")).toBe(true);
    expect(isBenignRelayError(undefined)).toBe(false);
    expect(isBenignRelayError({})).toBe(false);
  });
});
