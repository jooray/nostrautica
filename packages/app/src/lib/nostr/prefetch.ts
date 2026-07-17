/**
 * Predictive cache warmers: while the user is on one step, fetch what the NEXT
 * step will render (relays are slow; the dexie cache and the in-memory context
 * cache are fast). Every warmer is fire-and-forget, silent on failure, deduped
 * against concurrent/repeated triggers, and — critically — never causes a
 * remote-signer prompt: anything that would decrypt via Amber/NIP-07 only runs
 * for local-key signers.
 */
import { parseCoordinate } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { connectNdk } from "$lib/nostr/ndk.js";
import {
  loadEventContext,
  cachedEventContext,
  type EventContext,
} from "$lib/events/event-context.js";
import { fetchProfiles, fetchFollowSet } from "$lib/events/social.js";
import {
  fetchDirectory,
  fetchMatches,
  fetchRoster,
  receiveGrants,
} from "$lib/events/attendee.js";
import { fetchEventPage } from "$lib/events/event-page.js";
import { fetchEventPosts, fetchAttendeePosts } from "$lib/events/posts.js";
import { fetchTalks } from "$lib/events/talks.js";
import { fetchEventTheme } from "$lib/events/theme.js";
import { recoverEventKeys } from "$lib/events/recover.js";
import { fetchDms, fetchDmRelays } from "$lib/events/dm.js";
import { deriveBlindingKey } from "$lib/events/blinding.js";
import { mutes } from "$lib/stores/mutes.svelte.js";
import { fetchPending, fetchCoordinatorLastSeen } from "$lib/events/organizer.js";
import { fetchCoordinatorStatuses } from "$lib/events/coordinator-status.js";
import { fetchPendingTalks } from "$lib/events/talks.js";
import type { EventKeys } from "$lib/events/keystore.js";

// A repeated trigger (hover, re-render, remount) within the TTL is a no-op; an
// in-flight warm is never duplicated.
const TTL_MS = 30_000;
const inflight = new Map<string, Promise<void>>();
const doneAt = new Map<string, number>();

function warm(key: string, run: () => Promise<unknown>): void {
  const at = doneAt.get(key);
  if (at !== undefined && Date.now() - at < TTL_MS) return;
  if (inflight.has(key)) return;
  const job = (async () => {
    try {
      await connectNdk();
      await run();
      doneAt.set(key, Date.now());
    } catch {
      /* prefetch is best-effort — the real fetch on the next page reports errors */
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
}

/** Decryption without a user-visible prompt is only possible with a local key. */
function isSilentSigner(signer: AppSigner | null | undefined): signer is AppSigner {
  return !!signer && (signer.method === "local" || !!signer.getSecretKey?.());
}

/** Warm the event context (31600 + 31923 + E_id kind-0) for an naddr. */
export function prefetchEventContext(naddr: string | undefined): void {
  if (!naddr || cachedEventContext(naddr)) return;
  warm(`ctx:${naddr}`, () => loadEventContext(naddr, { adoptLang: false }));
}

/** Warm the kind-0 profiles the next screen shows (E_id + coordinator). */
export function prefetchOrganizerProfiles(ctx: EventContext): void {
  const pubkeys = [parseCoordinate(ctx.coordinate).pubkey];
  if (ctx.config.coordinator) pubkeys.push(ctx.config.coordinator);
  warm(`orgprofiles:${ctx.coordinate}`, () => fetchProfiles(pubkeys));
}

/** Warm what EventHome renders (layout + official feed) — the post-join landing. */
export function prefetchJoinLanding(ctx: EventContext): void {
  warm(`landing:${ctx.coordinate}`, () =>
    Promise.allSettled([fetchEventPage(ctx), fetchEventPosts(ctx)]),
  );
}

/**
 * Warm the Attendees tab: directory entries (ECK-decrypted from the keystore —
 * no signer, no prompt) + their kind-0 profiles; the match list too when the
 * signer can decrypt it silently.
 */
export function prefetchAttendeesTab(
  ctx: EventContext,
  signer: AppSigner | null,
): void {
  warm(`attendees:${ctx.coordinate}`, async () => {
    await fetchRoster(ctx);
    const entries = await fetchDirectory(ctx);
    if (entries.length) await fetchProfiles(entries.map((e) => e.pubkey));
  });
  if (ctx.config.coordinator && isSilentSigner(signer)) {
    warm(`matches:${ctx.coordinate}`, () => fetchMatches(signer, ctx));
  }
}

/** Warm the grant scan (approval status / ECK custody). Local signers only. */
export function prefetchGrants(signer: AppSigner | null): void {
  if (!isSilentSigner(signer)) return;
  warm("grants", () => receiveGrants(signer));
}

/** Warm organizer key recovery (30078 backups → keystore). Local signers only. */
export function prefetchOrganizerRecovery(signer: AppSigner | null): void {
  if (!isSilentSigner(signer)) return;
  warm("recovery", () => recoverEventKeys(signer));
}

/**
 * Identity-scoped warmers (CACHING-PLAN §2.15), run on login/session-restore:
 * grants, organizer recovery, own kind-0, follow set, DM relay list (all
 * prompt-free), plus mutes, blind seed (local derivation), and one DM inbox scan
 * — the last three only for a silent signer so no remote-signer prompt fires
 * (HARD CONSTRAINT 2).
 */
export function prefetchIdentity(signer: AppSigner | null): void {
  if (!signer) return;
  prefetchGrants(signer);
  prefetchOrganizerRecovery(signer);
  warm("self-kind0", async () => {
    await fetchProfiles([await signer.getPublicKey()], { force: true });
  });
  warm("followset", () => fetchFollowSet(signer)); // kind-3, no decrypt
  warm("dmrelays", async () => {
    await fetchDmRelays(await signer.getPublicKey()); // kind-10050, no decrypt
  });
  if (isSilentSigner(signer)) {
    warm("mutes", () => mutes.load(signer)); // nip44-decrypts private items
    warm("blindseed", () => deriveBlindingKey(signer)); // remote path fetches+decrypts
    warm("dmscan", () => fetchDms(signer)); // signerUnwrap per wrap
  }
}

/**
 * Content warmers for a coordinate (§2.15), run when a member opens/joins an
 * event: directory + profiles + posts + attendee posts + event page + talks +
 * theme (all keystore-ECK or public — no signer prompt); matches only for a
 * silent signer. "Joining an event precaches the People tab."
 */
export function prefetchEventContent(ctx: EventContext, signer: AppSigner | null): void {
  warm(`content:${ctx.coordinate}`, () =>
    Promise.allSettled([
      fetchEventPage(ctx),
      fetchEventPosts(ctx),
      fetchAttendeePosts(ctx),
      (async () => {
        const entries = await fetchDirectory(ctx);
        if (entries.length) await fetchProfiles(entries.map((e) => e.pubkey));
      })(),
      ctx.config.talks !== "off" ? fetchTalks(ctx) : Promise.resolve(),
      fetchEventTheme(ctx),
    ]),
  );
  if (ctx.config.coordinator && isSilentSigner(signer)) {
    warm(`matches:${ctx.coordinate}`, () => fetchMatches(signer, ctx));
  }
}

/**
 * Admin warmers for organizers (§2.15): pending queue, roster, coordinator
 * statuses + liveness, pending talks. All raw-key (E_id / E_inbox) unwraps the
 * organizer already holds — no remote-signer prompt. Admin then opens instantly.
 */
export function prefetchAdmin(ctx: EventContext, keys: EventKeys | undefined): void {
  if (!keys) return;
  warm(`admin:${ctx.coordinate}`, () =>
    Promise.allSettled([
      fetchPending(ctx, keys),
      fetchRoster(ctx),
      keys.eidNsecHex
        ? fetchCoordinatorStatuses(ctx, keys.eidNsecHex)
        : Promise.resolve([]),
      fetchCoordinatorLastSeen(ctx),
      ctx.config.talks !== "off" ? fetchPendingTalks(ctx, keys) : Promise.resolve([]),
    ]),
  );
}
