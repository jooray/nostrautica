/**
 * Whether the event's coordinator understands the 21607 add `intent` (NIP §6.2,
 * §10.2), i.e. whether its latest kind-31611 announcement lists
 * `"attest-intent"` in `features.chat`.
 *
 * A coordinator from before 0.18 rejects an add that carries `intent` at its strict
 * parse, so the device is never added. A bare add is accepted by every coordinator,
 * so anything short of a positive answer (no announcement seen yet, an unreadable
 * one, no relay answered) means "send no intent".
 *
 * Never blocks enrolment: {@link attestIntentFor} answers from what is already known
 * (the per-coordinator cache, or the coordinator picker's cached list) and starts a
 * background refresh when that is missing or old. The next attestation uses it.
 */
import {
  CHAT_FEATURE_ATTEST_INTENT,
  KIND_COORDINATOR_ANNOUNCE,
  coordinatorAnnounceSchema,
  supersedes,
  type ChatAttestationIntent,
  type CoordinatorAnnounce,
} from "@nostrautica/protocol";
import { fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { onlyVerified } from "$lib/nostr/verify.js";
import { cacheGet, cacheSet, ANON } from "$lib/cache/persist.js";
import { cachedCoordinators } from "$lib/events/coordinators.js";

/** Cache key of one coordinator's `features.chat`, anon scope (public data). */
const featuresKey = (coordinator: string) => `coordinator-chat-features:${coordinator.toLowerCase()}`;
/** A cached answer younger than this is not re-fetched. */
export const ATTEST_INTENT_TTL_SEC = 60 * 60;

/** True/false from an announcement; undefined when there is none. */
export function announceSupportsIntent(a: Pick<CoordinatorAnnounce, "features"> | undefined): boolean | undefined {
  if (!a) return undefined;
  return a.features?.chat?.includes(CHAT_FEATURE_ATTEST_INTENT) ?? false;
}

interface CachedFeatures {
  chat: string[];
  /** When it was read from a relay (unix s); the entry's own `at` is the event's created_at. */
  fetchedAt: number;
}

/** What is known right now, without the network. undefined = unknown. */
export function knownAttestIntentSupport(coordinator: string): boolean | undefined {
  const pk = coordinator.toLowerCase();
  const own = cacheGet<CachedFeatures>(featuresKey(pk), ANON)?.data;
  if (own) return own.chat.includes(CHAT_FEATURE_ATTEST_INTENT);
  const listed = cachedCoordinators()?.find((c) => c.pubkey.toLowerCase() === pk);
  return announceSupportsIntent(listed?.announce);
}

const inflight = new Map<string, Promise<boolean | undefined>>();

/**
 * Read the coordinator's latest 31611 from the discovery relays and cache its
 * `features.chat`. Deduped per coordinator. Resolves undefined when no valid
 * announcement came back (the cache is left as it was).
 */
export function refreshAttestIntentSupport(coordinator: string): Promise<boolean | undefined> {
  const pk = coordinator.toLowerCase();
  const running = inflight.get(pk);
  if (running) return running;
  const p = (async () => {
    // Announcements live on the discovery relays (fetchCoordinators, coordinatorReachable).
    const events = await fetchEventsRelayOnly(
      { kinds: [KIND_COORDINATOR_ANNOUNCE], authors: [pk], limit: 1 },
      undefined,
      { timeoutMs: 8000 },
    ).catch(() => []);
    let latest: (typeof events)[number] | undefined;
    for (const e of onlyVerified(events)) {
      if (e.pubkey !== pk || e.kind !== KIND_COORDINATOR_ANNOUNCE) continue;
      if (!latest || supersedes(e, latest)) latest = e;
    }
    if (!latest) return undefined;
    let announce: CoordinatorAnnounce;
    try {
      announce = coordinatorAnnounceSchema.parse(JSON.parse(latest.content));
    } catch {
      return undefined;
    }
    cacheSet<CachedFeatures>(featuresKey(pk), { chat: announce.features.chat, fetchedAt: Math.floor(Date.now() / 1000) }, latest.created_at ?? 0, ANON);
    return announceSupportsIntent(announce);
  })().finally(() => inflight.delete(pk));
  inflight.set(pk, p);
  return p;
}

/** Start a background refresh when the cached answer is missing or stale. Never awaits. */
export function prefetchAttestIntentSupport(coordinator: string | undefined): void {
  if (!coordinator) return;
  const entry = cacheGet<CachedFeatures>(featuresKey(coordinator), ANON)?.data;
  const fresh = entry !== undefined && Math.floor(Date.now() / 1000) - entry.fetchedAt < ATTEST_INTENT_TTL_SEC;
  if (!fresh) void refreshAttestIntentSupport(coordinator).catch(() => undefined);
}

/**
 * The `intent` to put on an add to `coordinator`: `wanted` when the coordinator
 * advertises support, otherwise undefined (a bare 0.17 add). Kicks off a refresh
 * when the answer is unknown or older than {@link ATTEST_INTENT_TTL_SEC}.
 */
export function attestIntentFor(
  coordinator: string | undefined,
  wanted: ChatAttestationIntent,
): ChatAttestationIntent | undefined {
  if (!coordinator) return undefined;
  prefetchAttestIntentSupport(coordinator);
  return knownAttestIntentSupport(coordinator) === true ? wanted : undefined;
}
