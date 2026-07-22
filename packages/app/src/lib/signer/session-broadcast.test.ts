/**
 * Cross-tab logout wire (H-5). The originating tab posts one `logout` message;
 * every other tab's handler fires with the owner so it can drop its live owner
 * state. Exercised with an injected channel — no real BroadcastChannel in the
 * test env.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  initSessionBroadcast,
  broadcastLogout,
  __resetSessionBroadcastForTests,
  type SessionChannelLike,
} from "./session-broadcast.js";

function fakeChannel() {
  let listener: ((ev: { data: unknown }) => void) | null = null;
  const posted: unknown[] = [];
  const channel: SessionChannelLike = {
    postMessage: (m) => posted.push(m),
    addEventListener: (_t, l) => (listener = l),
    close: () => {},
  };
  return { channel, posted, deliver: (data: unknown) => listener?.({ data }) };
}

describe("session-broadcast (H-5)", () => {
  beforeEach(() => __resetSessionBroadcastForTests());

  it("broadcasts a logout for the owner", () => {
    const { channel, posted } = fakeChannel();
    initSessionBroadcast(vi.fn(), () => channel);
    broadcastLogout("owner-pubkey");
    expect(posted).toEqual([{ t: "logout", owner: "owner-pubkey" }]);
  });

  it("invokes the handler with the owner on an incoming logout", () => {
    const { channel, deliver } = fakeChannel();
    const handler = vi.fn();
    initSessionBroadcast(handler, () => channel);
    deliver({ t: "logout", owner: "abc" });
    expect(handler).toHaveBeenCalledWith("abc");
  });

  it("ignores malformed / unrelated messages", () => {
    const { channel, deliver } = fakeChannel();
    const handler = vi.fn();
    initSessionBroadcast(handler, () => channel);
    deliver({ t: "other" });
    deliver(null);
    deliver({ t: "logout" }); // no owner
    expect(handler).not.toHaveBeenCalled();
  });

  it("broadcastLogout is a no-op before init (no channel)", () => {
    expect(() => broadcastLogout("x")).not.toThrow();
  });
});
