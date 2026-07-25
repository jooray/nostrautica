/**
 * Connect-time SSRF guard for relay WebSockets (audit C4), the websocket equivalent
 * of net/safe-fetch's DNS pinning. `sanitizeRelayUrls` handles the syntactic pass
 * (scheme, credentials, host-literal, allowlist), but a DNS-NAME relay host is only
 * resolved when the socket actually connects — so a host that resolves to a private
 * address, returns a MIXED public/private answer, or REBINDS between checks must be
 * caught here. This installs a policy-enforcing `lookup` on every relay connection:
 * every resolved address is checked against the same public-address policy as HTTP
 * fetches, and the whole connection is refused if ANY address is non-public. Because
 * the lookup runs at connect time (and on every reconnect), a rebinding attacker
 * cannot win the race between a validation and the connect.
 */
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import WS from "ws";
import { isBlockedAddress } from "./safe-fetch.js";

type LookupCallback = (...args: any[]) => void;
type LookupFn = (hostname: string, options: any, callback: LookupCallback) => void;

/** Module policy set once at daemon startup (audit C4). */
let allowInsecureRelays = false;

/** Set the relay connect policy (dev-only insecure/private allowance). */
export function setRelayConnectPolicy(opts: { allowInsecure: boolean }): void {
  allowInsecureRelays = opts.allowInsecure;
}

/**
 * A dns.lookup-compatible function that resolves the host and REFUSES the connection
 * if any resolved address is non-public (loopback/private/link-local/reserved) —
 * unless `allowInsecure` is set. `resolve` is injectable for tests; production uses
 * node's dns.lookup.
 */
export function makeGuardedLookup(
  resolve: LookupFn = dnsLookup as unknown as LookupFn,
  allowInsecure = false,
): LookupFn {
  return (hostname, options, callback) => {
    // An IP literal short-circuits DNS: check it directly.
    if (isIP(hostname) !== 0) {
      if (!allowInsecure && isBlockedAddress(hostname)) {
        callback(new Error(`relay host ${hostname} is a blocked (private/loopback/reserved) address`));
        return;
      }
      const family = isIP(hostname);
      if (options && options.all) callback(null, [{ address: hostname, family }]);
      else callback(null, hostname, family);
      return;
    }
    resolve(hostname, { ...(options ?? {}), all: true }, (err: Error | null, addresses: any) => {
      if (err) {
        callback(err);
        return;
      }
      const list: { address: string; family: number }[] = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        callback(new Error(`relay host ${hostname} did not resolve to any address`));
        return;
      }
      if (!allowInsecure) {
        // Reject a MIXED answer (any private address) — not just filter it (audit C4).
        for (const a of list) {
          if (isBlockedAddress(a.address)) {
            callback(new Error(`relay host ${hostname} resolved to a blocked address ${a.address}`));
            return;
          }
        }
      }
      if (options && options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/**
 * A `ws` WebSocket subclass that pins every relay connection to the policy-enforcing
 * lookup (audit C4). nostr-tools constructs `new WebSocket(url)`; injecting `lookup`
 * here makes the SSRF check run at the actual connect, covering DNS rebinding and
 * mixed-answer hosts that the syntactic sanitizer cannot see.
 */
export class GuardedWebSocket extends WS {
  constructor(address: string | URL, protocols?: any, options?: any) {
    super(address, protocols, {
      ...(options ?? {}),
      lookup: makeGuardedLookup(dnsLookup as unknown as LookupFn, allowInsecureRelays),
    });
  }
}
