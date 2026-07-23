import { expect, type BrowserContext, type Page } from "@playwright/test";
import { nip19 } from "nostr-tools";
import { WebSocket } from "ws";

/**
 * Shared spec helpers (stabilization pass, 2026-07-23). Previously every
 * integration/chat spec hand-rolled its own identical `newUser`; consolidated
 * here so the relay-ack fix below lands once, not in six copy-pasted places.
 */

const RELAY_URL = process.env.NOSTRAUTICA_E2E_RELAY;

/**
 * Create a brand-new local identity via the login form and hand back the page,
 * ready for the caller to navigate wherever the spec needs next (every caller
 * immediately does — this never assumes the page stays on /login).
 *
 * Login.svelte flips to the "You're in" screen the instant the local key
 * exists client-side, then publishes the new kind-0 profile in the
 * background — the UI never blocks on that publish landing on the relay.
 * Nearly every spec's very next step navigates this same user to an event's
 * /join page, whose logged-in branch (Join.svelte's loadExistingProfile)
 * re-fetches this identity's OWN kind-0 to prefill the join form. Under
 * relay contention that re-fetch can lose the race: it's bounded to 8s
 * (stream.ts `streamEvents` timeoutMs), and once it settles on "failed" or
 * "empty" the "Send join request" button (profile-load.ts canSubmitLoggedIn)
 * stays disabled indefinitely — no automatic retry — until the WHOLE test's
 * timeout expires, not just an extra 8s. That was the single largest source
 * of flakiness in the baseline runs (see playwright.config.ts for the numbers).
 *
 * A blind `waitForTimeout` here would just relocate the race, not close it.
 * Instead this polls the RELAY DIRECTLY over a raw NIP-01 websocket — the
 * exact condition Join.svelte's own fetch depends on (can this pubkey's kind-0
 * actually be read back yet) — bounded and retried off each EOSE, not a fixed
 * sleep. `workers: 1` on the relay-bound tiers should make this a non-event in
 * practice; this stays as defense in depth for any residual latency (a slow
 * CI host, disk-backed SQLite fsync, etc.) rather than reintroducing the
 * exact race by assuming serialization alone is always enough.
 */
export async function newUser(context: BrowserContext, name: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/#/login");
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /create my identity/i }).click();
  await expect(page.getByText(/you're in/i)).toBeVisible();
  const pubkey = await ownPubkeyHex(page);
  await pollRelayForEvent({ kinds: [0], authors: [pubkey] }, { timeoutMs: 20_000 });
  return page;
}

/**
 * The pubkey embedded in an event's naddr share link — this is E_id (the
 * per-event signing identity), NOT the organizer's personal pubkey
 * (create.ts: `coordinate = makeCoordinate(eidPubkey, d)`). Directory entries
 * (31603), the roster (31604), and key grants are all signed by E_id, so this
 * is the `authors` filter to use when polling the relay for those, not the
 * organizer's own npub from /#/me.
 */
export function eidPubkeyFromNaddr(naddr: string): string {
  const decoded = nip19.decode(naddr);
  if (decoded.type !== "naddr") throw new Error(`expected an naddr, got: ${naddr}`);
  return decoded.data.pubkey;
}

/**
 * This identity's own hex pubkey, read from /#/me (Me.svelte renders
 * `session.npub` straight off the local signer — no network involved, so this
 * adds no propagation wait of its own, just a client-side hash-route swap).
 * Every caller navigates elsewhere immediately after, so landing here doesn't
 * strand the page.
 */
export async function ownPubkeyHex(page: Page): Promise<string> {
  await page.goto("/#/me");
  const npubText = (await page.getByText(/^npub1/).innerText()).trim();
  const decoded = nip19.decode(npubText);
  if (decoded.type !== "npub") throw new Error(`unexpected /#/me handle: ${npubText}`);
  return decoded.data as string;
}

/**
 * Poll the relay directly for an event matching `filter`, re-issuing REQ after
 * each EOSE that comes back empty (EOSE is the relay's own "caught up, nothing
 * more" signal — waiting for the next one after a short beat is an ack-driven
 * retry, not a blind poll interval). Resolves the instant a matching event is
 * seen; rejects with a clear, diagnosable message if the relay genuinely never
 * got it in time. A no-op when no relay is configured for this tier.
 *
 * General enough to confirm ANY durable write landed (e.g. Admin's "Re-process"
 * republishing a kind-31603 directory entry) instead of guessing a fixed delay
 * after firing off a fire-and-forget UI action with no exposed busy state.
 */
export function pollRelayForEvent(
  filter: { kinds: number[]; authors?: string[]; since?: number },
  { timeoutMs = 20_000, relayUrl = RELAY_URL }: { timeoutMs?: number; relayUrl?: string } = {},
): Promise<void> {
  if (!relayUrl) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const subId = `probe-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const ws = new WebSocket(relayUrl);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(["CLOSE", subId]));
      } catch {
        /* socket may already be closing */
      }
      ws.close();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(
      () => finish(new Error(`no event matching ${JSON.stringify(filter)} appeared on ${relayUrl} within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const req = () => ws.send(JSON.stringify(["REQ", subId, filter]));

    ws.on("open", req);
    ws.on("message", (raw) => {
      if (settled) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === "EVENT" && msg[1] === subId) {
        finish();
      } else if (msg[0] === "EOSE" && msg[1] === subId) {
        setTimeout(() => {
          if (!settled) req();
        }, 500);
      }
    });
    ws.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}
