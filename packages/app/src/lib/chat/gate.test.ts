import { describe, it, expect } from "vitest";
import { evaluateChatGate, type ChatGateInput } from "./gate.js";

const base: ChatGateInput = {
  membershipKnown: true,
  shellNaddr: "naddr1",
  naddr: "naddr1",
  loading: false,
  showChat: true,
  hasSigner: true,
};

describe("evaluateChatGate (Bug 3 reactive membership gate)", () => {
  it("enters chat once membership is genuinely known and the viewer is a member", () => {
    expect(evaluateChatGate(base)).toBe("enter");
  });

  it("stays loading while our resolve pass hasn't completed (never latches negative)", () => {
    // showChat=false here would strand a user on a one-shot check — the gate must
    // NOT settle "unavailable" while membership is still unknown.
    expect(evaluateChatGate({ ...base, membershipKnown: false, showChat: false })).toBe(
      "loading",
    );
  });

  it("stays loading while the shell still reflects a different event", () => {
    expect(evaluateChatGate({ ...base, shellNaddr: "naddr-other", showChat: false })).toBe(
      "loading",
    );
  });

  it("stays loading while a shell sync is in flight", () => {
    expect(evaluateChatGate({ ...base, loading: true, showChat: false })).toBe("loading");
  });

  it("settles unavailable only once membership is known and the viewer is not a member", () => {
    expect(evaluateChatGate({ ...base, showChat: false })).toBe("unavailable");
  });

  it("settles unavailable when there is no signer", () => {
    expect(evaluateChatGate({ ...base, hasSigner: false })).toBe("unavailable");
  });

  it("transitions loading → enter when a late membership resolve lands (the Bug 3 fix)", () => {
    // Before the ECK-grant decrypt settles, the shell reports not-a-member but is
    // still resolving: gate = loading (not unavailable).
    const resolving: ChatGateInput = {
      ...base,
      membershipKnown: false,
      showChat: false,
    };
    expect(evaluateChatGate(resolving)).toBe("loading");
    // The grant decrypts, showChat flips true, resolve completes → enter.
    const resolved: ChatGateInput = {
      ...resolving,
      membershipKnown: true,
      showChat: true,
    };
    expect(evaluateChatGate(resolved)).toBe("enter");
  });
});
