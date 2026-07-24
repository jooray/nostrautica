/**
 * Connect-time relay SSRF guard (audit C4): the pinned lookup refuses a relay host
 * that resolves to a private address, returns a mixed public/private answer, or
 * rebinds between checks — the websocket equivalent of net/safe-fetch's DNS pinning.
 */
import { describe, it, expect } from "vitest";
import { makeGuardedLookup } from "./relay-guard.js";

/** Drive the lookup as node's net layer would (options.all=true) and capture the result. */
function resolveVia(
  lookup: ReturnType<typeof makeGuardedLookup>,
  host: string,
): Promise<{ err: Error | null; addresses: { address: string; family: number }[] | null }> {
  return new Promise((resolve) => {
    lookup(host, { all: true }, (err: Error | null, addresses: any) => {
      resolve({ err, addresses: err ? null : addresses });
    });
  });
}

/** A fake dns.lookup returning a fixed answer set for a host. */
function fakeResolver(map: Record<string, { address: string; family: number }[]>) {
  return (hostname: string, _options: any, callback: (...a: any[]) => void) => {
    const a = map[hostname];
    if (!a) callback(new Error("ENOTFOUND"));
    else callback(null, a);
  };
}

describe("makeGuardedLookup (audit C4)", () => {
  it("allows a host that resolves only to public addresses", async () => {
    const lookup = makeGuardedLookup(fakeResolver({ "relay.example": [{ address: "93.184.216.34", family: 4 }] }));
    const { err, addresses } = await resolveVia(lookup, "relay.example");
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses a host that resolves to a private/loopback address (internal DNS)", async () => {
    const lookup = makeGuardedLookup(fakeResolver({ "internal.example": [{ address: "10.0.0.5", family: 4 }] }));
    const { err } = await resolveVia(lookup, "internal.example");
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/blocked address 10\.0\.0\.5/);
  });

  it("refuses a MIXED public/private answer (rebinding defense)", async () => {
    const lookup = makeGuardedLookup(
      fakeResolver({ "mixed.example": [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] }),
    );
    const { err } = await resolveVia(lookup, "mixed.example");
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/blocked address 127\.0\.0\.1/);
  });

  it("refuses IPv6 loopback/unique-local", async () => {
    const lookup = makeGuardedLookup(fakeResolver({ "v6.example": [{ address: "::1", family: 6 }] }));
    const { err } = await resolveVia(lookup, "v6.example");
    expect(err).toBeTruthy();
  });

  it("short-circuits an IP literal host (blocks a private literal, allows a public one)", async () => {
    const lookup = makeGuardedLookup(fakeResolver({}));
    expect((await resolveVia(lookup, "127.0.0.1")).err).toBeTruthy();
    expect((await resolveVia(lookup, "93.184.216.34")).err).toBeNull();
  });

  it("the dev-only allowInsecure flag permits private answers", async () => {
    const lookup = makeGuardedLookup(fakeResolver({ "internal.example": [{ address: "10.0.0.5", family: 4 }] }), true);
    const { err, addresses } = await resolveVia(lookup, "internal.example");
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: "10.0.0.5", family: 4 }]);
  });
});
