/**
 * NIP-17 private direct messages (spec §7.2, rumor kind 14). Messages are
 * never signed as kind 14 — they travel sealed (13) and gift-wrapped (1059)
 * via the signer-based NIP-59 path, so they work with remote signers too.
 * Every send produces TWO wraps — one to the recipient, one to the sender's
 * own pubkey — so sent history is recoverable on any device. Plain NIP-17:
 * conversations continue in 0xchat/Amethyst/any NIP-17 client.
 */
import { KIND_DM, KIND_GIFT_WRAP, KIND_DM_RELAY_LIST, giftwrapSince } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { GiftWrap } from "@nostrautica/protocol";
import { signerWrap, signerUnwrap } from "./giftwrap.js";
import { fetchEvents, isAcceptedRelayUrl } from "$lib/nostr/ndk.js";
import { streamEvents } from "$lib/nostr/stream.js";
import { DEFAULT_RELAYS, unionRelays } from "$lib/nostr/relays.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

export interface DmMessage {
  id: string; // rumor id (stable across the recipient/self copies)
  peer: string; // the other party
  from: string; // author (== peer for received, == me for sent)
  text: string;
  at: number; // rumor created_at (wrap timestamps are randomized, NIP-59)
  /** Optimistic local echo only: the send landed in the offline queue (UX-4). */
  queued?: boolean;
}

export interface DmThread {
  peer: string;
  last: DmMessage;
  count: number;
}

/** Bound untrusted kind-10050 routing without crowding out the app defaults. */
export const MAX_DM_RELAYS = 20;

/** Extract the relay URLs from a NIP-17 DM relay list's (`["relay", url]`) tags. */
export function relayUrlsFromDmList(tags: string[][]): string[] {
  return unionRelays(
    tags
      .filter((t) => t[0] === "relay" && !!t[1] && isAcceptedRelayUrl(t[1]))
      .map((t) => t[1]),
  ).slice(0, MAX_DM_RELAYS);
}

/**
 * Where to deliver a gift-wrap addressed to `pubkey`: the recipient's declared
 * NIP-17 inboxes (kind-10050) UNIONED with sensible app defaults, so the DM
 * reaches the recipient's other clients while still landing on relays we know
 * are reachable. Falls back to defaults alone when the recipient has no 10050.
 */
export function selectDmRelays(
  recipientDmRelays: string[],
  defaults: string[] = DEFAULT_RELAYS,
): string[] {
  const safeDefaults = unionRelays(defaults.filter(isAcceptedRelayUrl)).slice(0, MAX_DM_RELAYS);
  const defaultSet = new Set(safeDefaults);
  const safeRecipient = unionRelays(recipientDmRelays.filter(isAcceptedRelayUrl)).filter(
    (url) => !defaultSet.has(url),
  );
  return unionRelays(
    safeRecipient.slice(0, Math.max(0, MAX_DM_RELAYS - safeDefaults.length)),
    safeDefaults,
  );
}

/** Fetch a pubkey's kind-10050 DM relay list; [] if they've published none. */
export async function fetchDmRelays(pubkey: string): Promise<string[]> {
  const events = await fetchEvents({ kinds: [KIND_DM_RELAY_LIST], authors: [pubkey] });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  return latest ? relayUrlsFromDmList(latest.tags) : [];
}

/**
 * Send `text` to `recipient`: one wrap to them, one to self. Each wrap is
 * published to that party's declared kind-10050 DM inboxes (union defaults) so
 * NIP-17 messages reach the recipient's other clients and the sender's own
 * sent-history copy lands on the sender's inboxes (audit G4). Missing 10050s
 * degrade gracefully to the default relays.
 *
 * Returns true when both wraps went out immediately, false when either landed
 * in the durable offline queue (audit UX-4) — the UI marks the message "queued,
 * will send when online" instead of implying it was delivered.
 */
export async function sendDm(
  signer: AppSigner,
  recipient: string,
  text: string,
): Promise<boolean> {
  const me = await signer.getPublicKey();
  const input = {
    kind: KIND_DM as typeof KIND_DM,
    content: text,
    tags: [["p", recipient]],
    // Both independently encrypted copies carry one byte-identical rumor.
    created_at: Math.floor(Date.now() / 1000),
  };
  const [recipientRelays, selfRelays] = await Promise.all([
    fetchDmRelays(recipient).catch(() => []),
    fetchDmRelays(me).catch(() => []),
  ]);
  const toRecipient = await signerWrap(signer, recipient, input);
  const toSelf = await signerWrap(signer, me, input);
  const published = await Promise.all([
    publishOrQueue(toRecipient as never, selectDmRelays(recipientRelays)),
    publishOrQueue(toSelf as never, selectDmRelays(selfRelays)),
  ]);
  return published.every(Boolean);
}

/**
 * Fetch and unwrap the user's DMs. Non-DM rumors (grants etc.) and wraps we
 * can't decrypt are skipped silently; copies are deduped by rumor id.
 */
// Per-wrap unwrap memo (keyed by wrap id, per identity): a wrap's plaintext never
// changes, and the 5s DM poll otherwise re-runs a signer decrypt per wrap per
// tick — for a remote signer (Amber/NIP-46) that's a prompt-or-roundtrip storm,
// and one unreachable bunker relay froze the DM screens entirely (user report
// 2026-07-16). `null` = decrypted fine but not a DM of ours — a DEFINITIVE
// outcome. Memoization happens only after the outcome is known (mirrors the
// receiveGrants policy in attendee.ts, audit APPK-5): a FAILED unwrap (signer
// timeout, offline Amber, corrupt wrap) is NOT memoized — a transient signer
// error must not permanently hide a genuine DM across reloads (audit UX-4).
// Failures are instead retried on the next scan, bounded per session by
// `unwrapAttempts` so a truly undecryptable wrap doesn't cost a signer
// round-trip on every 5s tick forever.
let unwrapCacheOwner = "";
const unwrapCache = new Map<string, DmMessage | null>();
/** In-memory per-wrap failure counts (session-scoped, never persisted). */
const unwrapAttempts = new Map<string, number>();
/** Scanned ciphertext waiting for the single signer loop to consume it. */
const pendingWraps = new Map<string, GiftWrap>();
const MAX_UNWRAP_ATTEMPTS = 5;
// Only one unwrap loop runs at a time — the 5s poll must not stack loops on top
// of a slow signer.
let unwrapInFlight: Promise<void> | null = null;

// The per-wrap unwrap memo is now PERSISTED owner-scoped (CACHING-PLAN §2.6):
// hydrated into `unwrapCache` on the first fetch per identity, so a DM decrypted
// once is never signer-decrypted again — across sessions — and the inbox paints
// full history instantly. Bounded to 3000 wraps (§3.5). Wiped on logout.
const DMWRAPS_KEY = "dmwraps";
const DMSCAN_KEY = "dmscanat"; // last steady-state scan time per owner
const MAX_DM_WRAPS = 3000;
export const DM_HISTORY_PAGE_LIMIT = 200;
export const DM_HISTORY_PAGES_PER_SCAN = 5;

interface DmScanState {
  lastScan?: number;
  historyUntil?: number;
  historyComplete?: boolean;
}

type DmMemo = Record<string, DmMessage | null>;

function snapshotFromMemo(memo: DmMemo): DmMessage[] {
  const byId = new Map<string, DmMessage>();
  for (const m of Object.values(memo)) if (m) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/**
 * Cached DM history for `me` (no network, no signer) — the inbox/thread paint
 * this synchronously before `connectNdk()` even resolves (§2.6).
 */
export function cachedDms(me: string): DmMessage[] {
  return snapshotFromMemo(cacheGet<DmMemo>(DMWRAPS_KEY, me)?.data ?? {});
}

function hydrateUnwrapCache(me: string): void {
  unwrapCache.clear();
  unwrapAttempts.clear();
  pendingWraps.clear();
  const memo = cacheGet<DmMemo>(DMWRAPS_KEY, me)?.data ?? {};
  for (const [id, m] of Object.entries(memo)) unwrapCache.set(id, m);
  unwrapCacheOwner = me;
}

/** Persist the unwrap memo, capped to the 3000 most-recent wraps by message time. */
function persistUnwrapCache(me: string): void {
  let entries = [...unwrapCache.entries()];
  if (entries.length > MAX_DM_WRAPS) {
    entries = entries
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      .slice(0, MAX_DM_WRAPS);
    // Also bound the in-memory map so it doesn't grow without limit.
    unwrapCache.clear();
    for (const [id, m] of entries) unwrapCache.set(id, m);
  }
  const memo: DmMemo = {};
  for (const [id, m] of entries) memo[id] = m;
  cacheSet(DMWRAPS_KEY, memo, Math.floor(Date.now() / 1000), me);
}

function snapshotDms(): DmMessage[] {
  const byId = new Map<string, DmMessage>();
  for (const m of unwrapCache.values()) if (m) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

function dmScanState(me: string): DmScanState {
  const saved = cacheGet<number | DmScanState>(DMSCAN_KEY, me)?.data;
  // Numeric values were written by the old one-shot limit:500 scan. Preserve
  // its steady cursor, but restart the resumable history walk so older wraps
  // hidden by that limit can now be discovered.
  return typeof saved === "number" ? { lastScan: saved } : (saved ?? {});
}

/**
 * Scan the owner's encrypted kind-1059 inbox without invoking the signer. This
 * is also the activity seam for callers that only need ciphertext arrival.
 *
 * History is walked backwards in bounded pages and resumed on later calls.
 * Nostr `until` is inclusive, so IDs are deduped across page boundaries. A relay
 * that repeatedly returns the same full boundary page is forced one second back
 * after no progress, preventing an infinite loop.
 */
export async function scanDmGiftWraps(
  me: string,
  opts: { history?: boolean } = {},
): Promise<GiftWrap[]> {
  const now = Math.floor(Date.now() / 1000);
  const state = dmScanState(me);
  const ownDmRelays = await fetchDmRelays(me).catch(() => []);
  const relays = selectDmRelays(ownDmRelays);
  const byId = new Map<string, GiftWrap>();

  // Keep the existing wide steady overlap while a separate cursor resumes old
  // history. This catches new wraps even when backfill spans several poll ticks.
  if (state.lastScan !== undefined || opts.history === false) {
    const since =
      state.lastScan === undefined
        ? giftwrapSince(now)
        : Math.min(giftwrapSince(now), state.lastScan - 24 * 60 * 60);
    const recent = (await streamEvents(
      { kinds: [KIND_GIFT_WRAP], "#p": [me], since },
      { relays, relayOnly: true, timeoutMs: 10_000 },
    ).ready) as unknown as GiftWrap[];
    for (const wrap of recent) byId.set(wrap.id, wrap);
  }

  let historyUntil = state.historyUntil;
  let historyComplete = state.historyComplete === true;

  for (
    let pageNo = 0;
    opts.history !== false && !historyComplete && pageNo < DM_HISTORY_PAGES_PER_SCAN;
    pageNo++
  ) {
    const filter = {
      kinds: [KIND_GIFT_WRAP],
      "#p": [me],
      limit: DM_HISTORY_PAGE_LIMIT,
      ...(historyUntil !== undefined ? { until: historyUntil } : {}),
    };
    const page = (await streamEvents(filter, {
      relays,
      relayOnly: true,
      timeoutMs: 10_000,
    }).ready) as unknown as GiftWrap[];

    for (const wrap of page) {
      byId.set(wrap.id, wrap);
    }
    if (page.length < DM_HISTORY_PAGE_LIMIT) {
      historyComplete = true;
      historyUntil = undefined;
      break;
    }

    const oldest = Math.min(...page.map((wrap) => wrap.created_at));
    if (!Number.isFinite(oldest)) {
      // Malformed pages cannot provide a usable cursor; retry on a later scan.
      break;
    }
    if (historyUntil !== undefined && oldest >= historyUntil) {
      historyUntil -= 1;
    } else {
      historyUntil = oldest;
    }
  }

  const nextState: DmScanState = {
    lastScan: now,
    historyComplete,
    ...(historyComplete || historyUntil === undefined ? {} : { historyUntil }),
  };
  cacheSet(DMSCAN_KEY, nextState, now, me);
  return [...byId.values()];
}

export async function fetchDms(signer: AppSigner): Promise<DmMessage[]> {
  const me = await signer.getPublicKey();
  if (unwrapCacheOwner !== me) hydrateUnwrapCache(me);
  const events = await scanDmGiftWraps(me);
  for (const wrap of events) {
    if (!unwrapCache.has(wrap.id)) pendingWraps.set(wrap.id, wrap);
  }

  // Unwrapping is a per-wrap signer round-trip; a remote signer (Amber/NIP-46)
  // with an unreachable relay makes each one hang to its timeout, so decrypting a
  // whole mailbox could freeze the screen. Run the loop in the background writing
  // to the cache, and RACE it against a short deadline — fetchDms returns whatever
  // decrypted so far (empty on a dead signer, so the UI leaves "Decrypting…" and
  // shows the composer), and the next 5s poll surfaces more as the cache fills.
  if (!unwrapInFlight) {
    unwrapInFlight = (async () => {
      // Polls may append while this loop awaits a remote signer. Map iteration
      // visits those additions, so paged ciphertext is not lost when its scan
      // cursor has already advanced.
      for (const wrap of pendingWraps.values()) {
        if (unwrapCache.has(wrap.id)) continue;
        // Bounded retries for past failures (see the memo policy above).
        if ((unwrapAttempts.get(wrap.id) ?? 0) >= MAX_UNWRAP_ATTEMPTS) {
          pendingWraps.delete(wrap.id);
          continue;
        }
        try {
          const rumor = await signerUnwrap(signer, wrap);
          if (rumor.kind !== KIND_DM) {
            unwrapCache.set(wrap.id, null);
            pendingWraps.delete(wrap.id);
            continue;
          }
          const recipient = rumor.tags.find((t) => t[0] === "p")?.[1];
          if (!recipient) {
            unwrapCache.set(wrap.id, null);
            pendingWraps.delete(wrap.id);
            continue;
          }
          const peer = rumor.pubkey === me ? recipient : rumor.pubkey;
          if (peer === me && rumor.pubkey !== me) {
            unwrapCache.set(wrap.id, null); // malformed
            pendingWraps.delete(wrap.id);
            continue;
          }
          unwrapCache.set(wrap.id, {
            id: rumor.id,
            peer,
            from: rumor.pubkey,
            text: rumor.content,
            at: rumor.created_at,
          });
          pendingWraps.delete(wrap.id);
        } catch {
          // Transient (signer timeout, offline) or foreign/corrupt — NOT
          // memoized: the next scan retries it, up to MAX_UNWRAP_ATTEMPTS per
          // session, so one bad signer moment can't hide a real DM for good.
          unwrapAttempts.set(wrap.id, (unwrapAttempts.get(wrap.id) ?? 0) + 1);
        }
      }
    })().finally(() => {
      // Persist the decrypted memo (capped) so it survives reloads (§2.6).
      persistUnwrapCache(me);
      unwrapInFlight = null;
    });
  }

  const deadline = new Promise<void>((r) => setTimeout(r, 12_000));
  await Promise.race([unwrapInFlight, deadline]);
  return snapshotDms();
}

/**
 * Merge relay-derived messages with optimistic local echoes (audit UX-3). A sent
 * DM's self-wrap takes a poll cycle to round-trip — and a queued offline send
 * isn't on relays at all — so wholesale replacing the render list with the memo
 * snapshot makes a just-sent message vanish until the next scan. Keep a local
 * echo (`local-*` id) until a memo entry with the same text and an approximate
 * timestamp exists; that copy then takes over (stable rumor id, no duplicate).
 * Pure so the merge policy is unit-tested.
 */
export function mergeOptimisticDms(relay: DmMessage[], local: DmMessage[]): DmMessage[] {
  const kept = local.filter(
    (l) =>
      l.id.startsWith("local-") &&
      !relay.some(
        (r) =>
          r.peer === l.peer &&
          r.from === l.from &&
          r.text === l.text &&
          Math.abs(r.at - l.at) <= 600, // rumor created_at ≈ send time
      ),
  );
  return [...relay, ...kept].sort((a, b) => a.at - b.at);
}

/** Group messages into per-peer threads, newest thread first. */
export function threadsOf(messages: DmMessage[]): DmThread[] {
  const byPeer = new Map<string, DmThread>();
  for (const m of messages) {
    const t = byPeer.get(m.peer);
    if (!t) byPeer.set(m.peer, { peer: m.peer, last: m, count: 1 });
    else {
      t.count += 1;
      if (m.at >= t.last.at) t.last = m;
    }
  }
  return [...byPeer.values()].sort((a, b) => b.last.at - a.last.at);
}
