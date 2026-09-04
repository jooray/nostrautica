/**
 * Organizer-side consumption of coordinator status (kind 21606, audit Q12).
 *
 * When a pipeline job exhausts its retries the coordinator gift-wraps a 21606
 * rumor to the event's E_id (sealed by the coordinator key), so a poisoned job is
 * visible to the organizer without reading server logs (spec §7.2, §9).
 *
 * The organizer client holds the E_id secret in the keystore, so it unwraps these
 * with the raw-secret-key `unwrapRumor` (the same path `fetchPending` uses for the
 * E_inbox) rather than the identity signer — the wrap is addressed to E_id, not to
 * the organizer's login identity. `unwrapRumor` binds `rumor.pubkey === seal.pubkey`,
 * so the unwrapped `rumor.pubkey` is the cryptographically verified sealer. We only
 * accept a status whose sealer is the coordinator named in the signed 31600 config
 * — an arbitrary Nostr key claiming to be the coordinator is rejected.
 */
import {
  KIND_GIFT_WRAP,
  KIND_COORDINATOR_STATUS,
  giftwrapSince,
  unwrapRumor,
  hexToBytes,
  coordinatorStatusContentSchema,
  type CoordinatorStatusContent,
  type Rumor,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";
import { getPublicKey } from "nostr-tools/pure";
import type { EventContext } from "./event-context.js";
import { fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

// Cached decrypted coordinator statuses, owner-scoped (CACHING-PLAN §2.11).
function coordStatusKey(coordinate: string): string {
  return `coordstatus:${coordinate}`;
}
/** Cached coordinator statuses for a coordinate (no network), or undefined. */
export function cachedCoordinatorStatuses(
  coordinate: string,
): CoordinatorStatusContent[] | undefined {
  return cacheGet<CoordinatorStatusContent[]>(coordStatusKey(coordinate))?.data;
}

/**
 * Authenticate a received 21606 status: it must be a coordinator-status rumor
 * sealed by the event's currently configured coordinator. `rumor.pubkey` is the
 * verified seal author (bound by `unwrapRumor`), so this rejects any status not
 * actually sealed by the configured coordinator key.
 */
export function authenticateCoordinatorStatus(
  rumor: Rumor,
  coordinatorPubkey: string | undefined,
): boolean {
  if (rumor.kind !== KIND_COORDINATOR_STATUS) return false;
  if (!coordinatorPubkey) return false;
  return rumor.pubkey === coordinatorPubkey;
}

/** Stable dedupe key for a status: one row per (stage, affected attendee). */
function statusKey(s: CoordinatorStatusContent): string {
  return `${s.stage}\x1f${s.pubkey ?? ""}`;
}

/**
 * Keep only the newest status per (stage, dedupe key), by `at`. A later `cleared`
 * status therefore supersedes an earlier `poison` for the same job.
 */
export function dedupeLatestStatuses(
  statuses: CoordinatorStatusContent[],
): CoordinatorStatusContent[] {
  const latest = new Map<string, CoordinatorStatusContent>();
  for (const s of statuses) {
    const key = statusKey(s);
    const prev = latest.get(key);
    if (!prev || s.at > prev.at) latest.set(key, s);
  }
  return [...latest.values()];
}

/**
 * Fetch, unwrap, authenticate, parse, and dedupe the coordinator status events
 * for this event. Returns the latest status per (stage, attendee); the caller
 * decides which states to render (e.g. only `poison`).
 */
export async function fetchCoordinatorStatuses(
  ctx: EventContext,
  eidNsecHex: string,
): Promise<CoordinatorStatusContent[]> {
  const coordinator = ctx.config.coordinator;
  if (!coordinator) return [];
  const eidSk = hexToBytes(eidNsecHex);
  const eidPubkey = getPublicKey(eidSk);

  // Relay-only read (see attendee.receiveGrants): a status must not be lost to the
  // cache/EOSE race. The wrap is addressed to E_id, so unwrapRumor(eidSk) succeeds
  // only for wraps genuinely sealed to us.
  const wraps = (await fetchEventsRelayOnly(
    { kinds: [KIND_GIFT_WRAP], "#p": [eidPubkey], since: giftwrapSince() },
    ctx.config.relays,
  )) as unknown as GiftWrap[];

  const statuses: CoordinatorStatusContent[] = [];
  for (const wrap of wraps) {
    let rumor: Rumor;
    try {
      // NIP §5/§6.1 per-recipient allowlist: E_id receives 21606 statuses here.
      // Anything else sealed to this key is not this reader's to interpret.
      rumor = unwrapRumor(wrap, eidSk, [KIND_COORDINATOR_STATUS]);
    } catch {
      continue; // not ours / malformed
    }
    if (!authenticateCoordinatorStatus(rumor, coordinator)) continue;
    let content: CoordinatorStatusContent;
    try {
      content = coordinatorStatusContentSchema.parse(JSON.parse(rumor.content));
    } catch {
      continue;
    }
    if (content.a !== ctx.coordinate) continue; // status for a different event
    statuses.push(content);
  }
  const deduped = dedupeLatestStatuses(statuses);
  const newestAt = deduped.reduce((m, s) => Math.max(m, s.at), 0);
  cacheSet(coordStatusKey(ctx.coordinate), deduped, newestAt);
  return deduped;
}
