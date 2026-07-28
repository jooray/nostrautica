import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isBenignRelayError,
  categorizeError,
  errorDetail,
  isStaleChunkError,
  noteRelayPublishFailure,
} from "./errors.js";

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

describe("noteRelayPublishFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  // The whitenoise relays in a chat-enabled event's relay set refuse every kind
  // outside 0/3/445/1059/10000/10002/10050/30443, so a 31600 or kind-5 publish
  // fails there on EVERY attempt. That has to stay findable in a console without
  // being an error anyone should act on.
  it("records an expected refusal at debug level, never as an error", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteRelayPublishFailure(
      "wss://relay.us.whitenoise.chat",
      new Error("blocked: kind 5 is not accepted by this relay"),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      "[relay] wss://relay.us.whitenoise.chat declined the event: blocked: kind 5 is not accepted by this relay",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns on a failure that does NOT read like a normal relay rejection", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteRelayPublishFailure("wss://relay.example", new Error("Cannot read properties of undefined"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("publish failed"));
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("accepts a bare string reason and a missing one", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteRelayPublishFailure("wss://relay.example", "Timeout: 2500ms");
    noteRelayPublishFailure("wss://relay.example", undefined);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1); // "declined" isn't a known pattern
  });
});

describe("categorizeError (Q3)", () => {
  it("offline wins over the message when the browser is offline", () => {
    expect(categorizeError(new Error("not found"), { online: false })).toBe("offline");
  });
  it("classifies by message when online", () => {
    expect(categorizeError(new Error("request timed out"), { online: true })).toBe("timeout");
    expect(categorizeError(new Error("event not found"), { online: true })).toBe("notFound");
    expect(categorizeError(new Error("unauthorized"), { online: true })).toBe("access");
    expect(categorizeError(new Error("failed to decrypt NIP-44 payload"), { online: true })).toBe("decrypt");
    expect(categorizeError(new Error("boom"), { online: true })).toBe("generic");
    expect(categorizeError("plain string", { online: true })).toBe("generic");
  });
});

describe("errorDetail (Q3) redaction", () => {
  it("redacts 64-hex keys and nsec secrets", () => {
    const d = errorDetail(new Error(`bad key ${"a".repeat(64)} and nsec1abcdefхx`.replace("х", "x")));
    expect(d).not.toContain("a".repeat(64));
    expect(d).toContain("…");
    expect(d).not.toMatch(/nsec1[0-9a-z]{5,}/);
  });
});

describe("isStaleChunkError (post-deploy missing chunk)", () => {
  it("recognizes browser phrasings for a deleted content-hashed chunk", () => {
    for (const m of [
      "Failed to fetch dynamically imported module: https://example/app/_app/immutable/chunks/W3Bonw05.js",
      "TypeError: error loading dynamically imported module",
      "Importing a module script failed.",
      "Loading chunk 5 failed.\n(error: https://example/chunk.js)",
    ]) {
      expect(isStaleChunkError(new Error(m)), m).toBe(true);
    }
  });

  it("does not treat ordinary network/app errors as stale chunks", () => {
    for (const m of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Cannot read properties of undefined",
      "not found",
    ]) {
      expect(isStaleChunkError(new Error(m)), m).toBe(false);
    }
  });
});
