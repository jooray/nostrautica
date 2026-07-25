<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import { fetchRoster, cachedRoster, fetchDirectory, cachedDirectory, receiveGrants } from "$lib/events/attendee.js";
  import {
    mergePending,
    visiblePending,
    buildApprovedPeople,
    summarizeBulk,
    filterPeople,
    type AdminPerson,
    type BulkItem,
    type PeopleFilter,
  } from "$lib/events/admin-people.js";
  import { buildOverview } from "$lib/events/admin-overview.js";
  import AdminOverview from "$lib/components/AdminOverview.svelte";
  import type { DirectoryEntryContent, RosterContent } from "@nostrautica/protocol";
  import {
    loadReview,
    setReview,
    pubkeysInState,
    loadDismissedStatuses,
    saveDismissedStatuses,
    purgeLegacyGlobalReviewState,
    type ReviewMap,
    type ReviewState,
  } from "$lib/stores/review-state.js";
  import {
    fetchPending,
    cachedPending,
    approveAttendee,
    fetchCoordinatorLastSeen,
    cachedCoordinatorLastSeen,
    generateInvites,
    revokeAttendeeClient,
    sendAdminCommand,
    checkForOrganizerGrant,
    pollForOrganizerGrant,
    type PendingRequest,
    type GeneratedInvite,
  } from "$lib/events/organizer.js";
  import { fetchCoordinatorStatuses, cachedCoordinatorStatuses } from "$lib/events/coordinator-status.js";
  import { enrollOrganizerAsParticipant } from "$lib/events/create.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { checkoutUrlForEvent } from "$lib/events/coordinators.js";
  import { fetchPendingTalks, cachedPendingTalks, type PendingTalk } from "$lib/events/talks.js";
  import { perfMark } from "$lib/perf.js";
  import type { CoordinatorStatusContent } from "@nostrautica/protocol";
  import QrCode from "$lib/components/QrCode.svelte";
  import SecretSurface from "$lib/components/SecretSurface.svelte";
  import InviteSheet from "$lib/components/InviteSheet.svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { cachedEventPosts } from "$lib/events/posts.js";
  import AdminTabs from "$lib/components/AdminTabs.svelte";
  import AdminPersonDrawer from "$lib/components/AdminPersonDrawer.svelte";
  import AdminTalks from "$lib/components/AdminTalks.svelte";
  import AdminCommunicate from "$lib/components/AdminCommunicate.svelte";
  import AdminPeople from "$lib/components/AdminPeople.svelte";
  import AdminQueue from "$lib/components/AdminQueue.svelte";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";
  import { copyText } from "$lib/util/clipboard.js";

  let { naddr }: { naddr: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let keys = $state<EventKeys | null>(null);
  // `pending` is the DURABLE known join queue (UX-A2): a bounded relay refresh is
  // merged into it, never allowed to replace it, so a transient partial fetch
  // can't drop a request the organizer already saw.
  let pending = $state<PendingRequest[]>([]);
  let approvedSet = $state<Set<string>>(new Set()); // approved this session
  let rosterApproved = $state<Set<string>>(new Set()); // approved per the roster
  // The full decrypted roster (UX-A1 source of truth) + directory entries, so the
  // approved People section can be enumerated from durable state and enriched.
  let roster = $state<RosterContent | undefined>(undefined);
  let directory = $state<DirectoryEntryContent[] | undefined>(undefined);
  // Data-freshness stamp, shown distinctly from item state (UX-A2).
  let lastRefreshed = $state<number | undefined>(undefined);
  let loading = $state(true);
  // A subtle "refreshing…" affordance while background refreshes run on top of a
  // cached paint (CACHING-PLAN §2.11, §3.4) — spinners only on a true cold open.
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let notOrganizer = $state(false);
  let missingEidKey = $state(false); // organizer role but no E_id secret on this device
  let copiedLink = $state(false);
  let copiedNpub = $state(false);
  let coordLastSeen = $state<number | undefined>(undefined);
  let coordLivenessChecked = $state(false);
  let destroyed = false;

  // Join-queue auto-refresh (audit UX-9): a request that arrives while Admin is
  // open used to need a manual Refresh. Poll slowly; cleared on destroy.
  let queuePoll: ReturnType<typeof setInterval> | undefined;
  onDestroy(() => {
    destroyed = true;
    clearInterval(queuePoll);
  });

  // Approved = anyone in the roster OR approved just now. Reading the roster makes
  // approval persist across refreshes (it's not just session state).
  function isApprovedNow(pubkey: string): boolean {
    return approvedSet.has(pubkey) || rosterApproved.has(pubkey);
  }
  // Pubkeys revoked this session. A just-revoked attendee keeps their card in the
  // Approved section (rendering "Revoked ✓"), so the outcome stays visible even
  // once a background refresh drops them from the roster — otherwise the card
  // would silently flip into the pending queue as a fresh, re-approvable request
  // (their join 21601 is still on the relay), which is both confusing and racy
  // (caching verification 2026-07-17: the e2e revoke assertion never caught the
  // transient "Revoked ✓" because the refresh moved the card first). Excluded
  // from pendingRequests for the same reason.
  let revokedSet = $state<Set<string>>(new Set());
  // Local admission review state (UX-A7): rejected requests drop from the queue
  // (local-only, no protocol action); deferred ones stay but stop looking new.
  let reviewMap = $state<ReviewMap>({});
  const rejectedSet = $derived(pubkeysInState(reviewMap, "rejected"));
  const deferredSet = $derived(pubkeysInState(reviewMap, "deferred"));
  // The pending QUEUE view: known requests minus confirmed transitions (approved
  // in the roster / approved just now / revoked) and local rejections (UX-A7).
  // The merge never drops a known request (UX-A2).
  const pendingRequests = $derived(visiblePending(pending, isApprovedNow, revokedSet, rejectedSet));

  function review(pubkey: string, state: ReviewState | undefined) {
    if (!ctx) return;
    reviewMap = setReview(ctx.coordinate, reviewMap, pubkey, state);
  }
  // Inline reject confirmation lives in AdminQueue (which owns the confirm state).
  // The approved People section is enumerated from the durable roster (UX-A1),
  // enriched with recent intake + directory + statuses (statuses are folded in
  // via `approvedPeople`, declared after coordStatuses is available).

  // The organizer is a participant of their own event only if they've enrolled
  // (the create-form checkbox, or the button below). Being the organizer is NOT
  // the same as being on the roster — and the group chat only includes roster
  // members, so an un-enrolled organizer can't see the chat (user feedback
  // 2026-07-17).
  const selfEnrolled = $derived(!!session.pubkey && rosterApproved.has(session.pubkey));
  let enrollingSelf = $state(false);
  let enrollSent = $state(false);
  let enrollError = $state<string | null>(null);

  async function enrollSelf() {
    if (!ctx || !session.signer) return;
    enrollingSelf = true;
    enrollError = null;
    try {
      const bk = await deriveBlindingKey(session.signer);
      const base = window.location.origin + window.location.pathname;
      await enrollOrganizerAsParticipant(session.signer, ctx, bk, base);
      // Fold in the grant we just self-issued + refresh the roster. With a
      // coordinator attached, the authoritative roster is the coordinator's — it
      // republishes (and adds us to the group chat via syncMember) a few seconds
      // after it processes our join request, so `selfEnrolled` flips on a later
      // refresh; show a "sent" note meanwhile.
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      await refresh();
      enrollSent = true;
    } catch (e) {
      enrollError = e instanceof Error ? e.message : String(e);
    } finally {
      enrollingSelf = false;
    }
  }

  // Refresh-button/interval entry point (audit UX-27): a rejected refresh must
  // surface on the shared error card, never as an unhandled rejection.
  async function refreshGuarded() {
    try {
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function refresh() {
    if (!ctx || !keys) return;
    // Fetch pending + roster CONCURRENTLY and assign atomically (same tick): a
    // sequential `pending = await fetchPending(...)` followed by a separate
    // `await fetchRoster(...)` opens a window where `pending` already includes
    // the organizer's own residual self-enrollment request but `rosterApproved`
    // hasn't caught up yet, so it briefly renders an actionable "Approve" button
    // for an already-approved organizer — a fast click (or an impatient human)
    // can land on it instead of the real pending attendee's button, silently
    // re-publishing the roster without the new attendee (bug found in caching
    // verification 2026-07-17: the parallel Promise.allSettled refresh made this
    // window wide enough to hit reliably in the e2e suite).
    const [freshPending, freshRoster] = await Promise.all([
      fetchPending(ctx, keys),
      fetchRoster(ctx).catch(() => undefined),
    ]);
    // Merge, don't replace (UX-A2): a bounded/partial relay scan folds INTO the
    // known queue; a request already seen is never dropped by its absence here.
    pending = mergePending(pending, freshPending);
    // The roster is the durable approved source (UX-A1). A failed fetch keeps the
    // last-known roster rather than blanking the approved section.
    if (freshRoster) {
      roster = freshRoster;
      rosterApproved = new Set(freshRoster.attendees.map((a) => a.pubkey));
    }
    lastRefreshed = Math.floor(Date.now() / 1000);
    // Enrich approved people with their directory entries (best-effort; the
    // organizer holds the ECK). Runs in the background so it never blocks the
    // queue paint.
    void fetchDirectory(ctx)
      .then((d) => {
        if (!destroyed) directory = d;
      })
      .catch(() => {});
    // Pending talk submissions (spec F2.3) — moderation needs a coordinator to
    // publish the 31610, so only fetch the queue when one is attached.
    pendingTalks =
      ctx.config.talks !== "off" && ctx.config.coordinator
        ? await fetchPendingTalks(ctx, keys).catch(() => [])
        : [];
  }

  // ── pending talk moderation (spec F2.3) ────────────────────────────────────
  // The moderation UI + its per-talk interaction state (preview / in-flight) live
  // in AdminTalks (domain split). The page keeps the source list + the acted-on
  // set because the ops-overview count (`talksAwaiting`) reads `visibleTalks`.
  let pendingTalks = $state<PendingTalk[]>([]);
  let moderatedTalks = $state<Set<string>>(new Set()); // acted-on this session
  function tkKey(tk: PendingTalk): string {
    return `${tk.pubkey}:${tk.talkD}`;
  }
  const visibleTalks = $derived(pendingTalks.filter((tk) => !moderatedTalks.has(tkKey(tk))));

  function scrollToRequests() {
    document.getElementById("join-requests")?.scrollIntoView({ behavior: "smooth" });
  }

  // Centralized copy (audit U15): truthful success/failure with a select-manually
  // fallback. Invite links (secrets) are already rendered on-screen (the .mono
  // rows below), so a failed copy still leaves the value visible to select.
  let copyFailed = $state(false);
  async function doCopy(text: string, onOk: () => void): Promise<void> {
    if ((await copyText(text)) === "copied") {
      copyFailed = false;
      onOk();
    } else {
      copyFailed = true;
      setTimeout(() => (copyFailed = false), 4000);
    }
  }

  async function copyInviteLink() {
    const link = `${window.location.origin}${window.location.pathname}#/e/${naddr}/join`;
    await doCopy(link, () => {
      copiedLink = true;
      setTimeout(() => (copiedLink = false), 1500);
    });
  }

  onMount(async () => {
    try {
      // U11: drop pre-U11 device-global review/dismissed entries (never migrated).
      purgeLegacyGlobalReviewState();
      await connectNdk();
      ctx = await loadEventContext(naddr);
      keys = (await loadEventKeys(ctx.coordinate)) ?? null;
      // A device can hold the organizer ROLE without the E_id secret (e.g. the
      // role arrived via a 21602 ECK grant, or a partial state) — then every
      // admin write ("E_id key not available"). Try to restore it from the 30078
      // self-backup before giving up (user feedback 2026-07-17).
      if (session.signer && keys?.role === "organizer" && !keys.eidNsecHex) {
        await recoverEventKeys(session.signer, { force: true }).catch(() => {});
        keys = (await loadEventKeys(ctx.coordinate)) ?? keys;
      }
      if (!keys || keys.role !== "organizer") {
        notOrganizer = true;
        // The organizer keys may arrive as a 21605 grant (co-organizer / hand-off
        // to another device) — poll while the page is open so it unlocks without a
        // manual reload (P2 recovery path). Same receiveGrants channel the app uses.
        // Note this can also fire on a device that DOES hold the keys: with a
        // NIP-46 session still restoring there is no active keystore owner yet, so
        // the loadEventKeys above returns undefined regardless of what is stored.
        // The poll re-reads the keystore every pass, which repairs that too.
        void startGrantWait();
        return;
      }
      // Organizer role but still no E_id after recovery: writes will fail, so
      // flag it and surface a clear message instead of cryptic per-action errors.
      missingEidKey = !keys.eidNsecHex;
      // Paint every Admin slice from cache instantly (§2.11): pending, roster
      // approvals, pending talks, statuses, last-seen, updates.
      paintFromCache();
      loading = false;
      perfMark("Admin", "cache-paint");
      // Then run all refreshes in parallel — they're independent — updating each
      // slice as it lands. The relay-only scan semantics are untouched.
      refreshing = true;
      // Liveness paints no user-facing strap slice, so let it finish silently in
      // the background (§2.11): clear the "Refreshing…" affordance as soon as the
      // user-facing slices (pending + updates) settle, rather than lingering for
      // the slowest background member. network-settled (finally) still waits for
      // everything, so perf marks stay meaningful.
      const background = Promise.allSettled([refreshLiveness()]);
      await Promise.allSettled([refresh()]);
      refreshing = false;
      await background;
      // Keep the join queue fresh while the page stays open (UX-9).
      queuePoll = setInterval(() => void refreshGuarded(), 30_000);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      refreshing = false;
      perfMark("Admin", "network-settled");
    }
  });

  /** Seed every slice from the persistent cache for an instant Admin paint (§2.11). */
  function paintFromCache() {
    if (!ctx) return;
    const coord = ctx.coordinate;
    // Seed the durable queue from cache, then merge so a stale cached entry never
    // clobbers a fresher in-memory one (UX-A2).
    pending = mergePending(pending, cachedPending(coord) ?? []);
    roster = cachedRoster(coord) ?? roster;
    directory = cachedDirectory(coord) ?? directory;
    reviewMap = loadReview(coord); // UX-A7 / U11: owner-scoped reject/defer state
    dismissedStatuses = new Set(loadDismissedStatuses(coord)); // U11: owner-scoped
    rosterApproved = new Set(roster?.attendees.map((a) => a.pubkey) ?? [...rosterApproved]);
    pendingTalks = cachedPendingTalks(coord) ?? pendingTalks;
    coordStatuses = cachedCoordinatorStatuses(coord) ?? coordStatuses;
    coordLastSeen = cachedCoordinatorLastSeen(coord) ?? coordLastSeen;
  }

  // ── Waiting for organizer custody (P2 recovery path) ───────────────────────
  // The card below used to print a static "Waiting for the grant…" with nothing
  // behind it. These make the wait's real state renderable — and give the
  // organizer a manual check, which is what would have let the device-B report
  // (2026-07-24) self-recover instead of looking permanently locked out.
  let grantWaiting = $state(false); // a poll loop is actually running
  let grantChecking = $state(false); // a manual "Check now" is in flight
  let grantCheckedAt = $state<number | undefined>(undefined); // ms, last completed pass
  let grantCheckError = $state<string | null>(null);

  async function startGrantWait() {
    if (!ctx || grantWaiting) return; // never two loops for one page
    const coordinate = ctx.coordinate;
    grantWaiting = true;
    try {
      await pollForOrganizerGrant({
        coordinate,
        // Read per pass, not captured: with NIP-46 the signer lands seconds after
        // mount (routes/+layout.svelte doesn't await the restore), and the old
        // poll's up-front `if (!session.signer) return` meant it never ran at all.
        signer: () => session.signer,
        receiveGrants,
        stopped: () => destroyed || !notOrganizer,
        onChecked: () => (grantCheckedAt = Date.now()),
        onGranted: adoptOrganizerKeys,
      });
    } finally {
      grantWaiting = false;
    }
  }

  /** Manual "Check now": the same pass the poll runs, on demand. */
  async function checkGrantNow() {
    if (!ctx || grantChecking) return;
    grantChecking = true;
    grantCheckError = null;
    try {
      const k = await checkForOrganizerGrant(ctx.coordinate, session.signer, receiveGrants);
      grantCheckedAt = Date.now();
      if (k) await adoptOrganizerKeys(k);
    } catch (e) {
      // Unlike the poll, a manual check reports its failure — the user asked.
      grantCheckError = e instanceof Error ? e.message : String(e);
    } finally {
      grantChecking = false;
    }
  }

  /** Unlock the page with organizer keys that arrived after mount. */
  async function adoptOrganizerKeys(k: EventKeys) {
    keys = k;
    missingEidKey = !k.eidNsecHex;
    notOrganizer = false;
    loading = true;
    try {
      await refresh();
      void refreshLiveness();
    } finally {
      loading = false;
    }
  }

  // The keystore is owner-scoped and resolves against the ACTIVE owner, which the
  // session only sets once its restore completes. A page that mounted before that
  // (the NIP-46 window above) read an empty keystore, so a device that DOES hold
  // the organizer keys shows the "not the organizer" card. Re-read the moment the
  // signer lands rather than making the user wait for the next poll pass — it's a
  // local IndexedDB read, and receiveGrants is deliberately left to the poll so
  // the two paths can't both scan relays at once.
  $effect(() => {
    const signer = session.signer;
    if (!signer || !notOrganizer || !ctx) return;
    const coordinate = ctx.coordinate;
    void loadEventKeys(coordinate)
      .then((k) => {
        if (k?.role === "organizer" && !destroyed && notOrganizer) void adoptOrganizerKeys(k);
      })
      .catch(() => {});
  });

  async function refreshLiveness() {
    if (!ctx?.config.coordinator) return;
    coordLivenessChecked = false;
    try {
      coordLastSeen = await fetchCoordinatorLastSeen(ctx).catch(() => undefined);
      await refreshCoordStatus();
    } finally {
      coordLivenessChecked = true;
    }
  }

  // Human "active 2 min ago" from a unix seconds timestamp.
  function sinceLabel(unixSec: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (s < 90) return t("admin.coord.justNow");
    if (s < 3600) return t("admin.coord.minAgo", { n: Math.round(s / 60) });
    if (s < 86400) return t("admin.coord.hAgo", { n: Math.round(s / 3600) });
    return t("admin.coord.dAgo", { n: Math.round(s / 86400) });
  }
  const coordStale = $derived(
    coordLastSeen !== undefined &&
      Math.floor(Date.now() / 1000) - coordLastSeen > 3600,
  );

  // Coordinator status (kind 21606, audit Q12): poisoned/health items surfaced by
  // the coordinator, gift-wrapped to E_id and authenticated against the configured
  // coordinator key. Dismiss is local-only (never a protocol action).
  let coordStatuses = $state<CoordinatorStatusContent[]>([]);
  // Enumerated from the durable roster (UX-A1), enriched with intake + directory +
  // statuses. A roster member with no fetchable intake still appears
  // (intakeAvailable=false) with working revoke/reprocess controls.
  const approvedPeople = $derived<AdminPerson[]>(
    buildApprovedPeople({
      roster,
      sessionApproved: approvedSet,
      revoked: revokedSet,
      known: pending,
      directory,
      statuses: coordStatuses,
    }),
  );
  // Owner-scoped (audit U11): seeded from the owner+coordinate cache in
  // paintFromCache once the coordinate is known, not a device-global list.
  let dismissedStatuses = $state<Set<string>>(new Set());
  let retryingStatus = $state<string | null>(null);

  function statusId(s: CoordinatorStatusContent): string {
    return `${s.a}${s.stage}${s.pubkey ?? ""}`;
  }

  function persistDismissed() {
    if (!ctx) return;
    saveDismissedStatuses(ctx.coordinate, [...dismissedStatuses]);
  }

  // Only unresolved poison items the organizer hasn't dismissed.
  const poisonStatuses = $derived(
    coordStatuses.filter(
      (s) => s.state === "poison" && !dismissedStatuses.has(statusId(s)),
    ),
  );

  // Latest billing signal from the coordinator (payment_required / grace).
  // Payment is external for now — we just surface the reason + a checkout link,
  // with the event identifier appended so the checkout page knows the event.
  const billing = $derived.by(() => {
    const withBilling = coordStatuses
      .filter((s) => s.billing && s.billing.state !== "ok")
      .sort((a, b) => b.at - a.at);
    return withBilling[0]?.billing;
  });
  // checkoutUrlForEvent returns null for non-https URLs (audit APPR-2) — the
  // link is simply hidden then.
  const billingCheckoutUrl = $derived(
    billing?.checkout_url ? checkoutUrlForEvent(billing.checkout_url, naddr) : undefined,
  );

  // Operational overview (UX-A5): headline metrics + exceptions, all derived from
  // state the page already holds. `matchesAvailable` uses the matching-enabled
  // config as an honest proxy (a true per-event match aggregate isn't fetched
  // here — see report).
  const overview = $derived(
    buildOverview({
      pendingCount: pendingRequests.length,
      approvedCount: approvedPeople.filter((p) => !p.revoked).length,
      missingIntros: approvedPeople.filter((p) => !p.revoked && !p.hasIntro).length,
      failedJobs: poisonStatuses.length,
      talksAwaiting: visibleTalks.length,
      matchesAvailable: ctx?.config.matching === "on",
      hasCoordinator: !!ctx?.config.coordinator,
      coordinatorStale: coordStale,
      coordinatorUnknown: coordLastSeen === undefined,
      billingBlocked: !!billing,
    }),
  );

  // People search + filter (UX-A6): reuse the roster matching shape for the admin
  // People list. `all` includes pending + approved; filters narrow it.
  let peopleFilter = $state<PeopleFilter>("all");
  let peopleQuery = $state("");
  const talkPubkeys = $derived(new Set(pendingTalks.map((tk) => tk.pubkey)));
  const filterablePeople = $derived([
    ...pendingRequests.map((r) => ({
      pubkey: r.attendeePubkey,
      name: r.name,
      approved: false,
      hasIntro: !!(r.media?.length || r.introText?.trim()),
      op: "ok" as const,
      hasTalk: talkPubkeys.has(r.attendeePubkey),
    })),
    ...approvedPeople.map((p) => ({
      pubkey: p.pubkey,
      name: p.name,
      approved: true,
      hasIntro: p.hasIntro,
      op: p.op,
      hasTalk: talkPubkeys.has(p.pubkey),
    })),
  ]);
  const filteredPeople = $derived(filterPeople(filterablePeople, peopleFilter, peopleQuery));
  // The set of pubkeys that pass the current search/filter, used to narrow the
  // rendered pending + approved sections (empty query/all → show everything).
  const peopleFilterActive = $derived(peopleFilter !== "all" || peopleQuery.trim().length > 0);
  const matchedPubkeys = $derived(new Set(filteredPeople.map((p) => p.pubkey)));

  // Per-person operational drawer (Phase 5A carry-over a): submitted profile +
  // provenance + operational history (coordinator statuses / talks) for one
  // attendee, all from data already loaded here. `detailPubkey` selects them.
  let detailPubkey = $state<string | null>(null);
  const detailProps = $derived.by(() => {
    const pk = detailPubkey;
    if (!pk) return null;
    const approved = approvedPeople.find((p) => p.pubkey === pk);
    const req = pendingRequests.find((r) => r.attendeePubkey === pk);
    if (!approved && !req) return null;
    const talksFor = pendingTalks
      .filter((tk) => tk.pubkey === pk)
      .map((tk) => ({ title: tk.title, status: "pending" as const }));
    return {
      pubkey: pk,
      name: approved?.name ?? req?.name ?? short(pk),
      role: approved?.role ?? "attendee",
      revoked: approved?.revoked ?? false,
      inRoster: approved?.inRoster ?? false,
      intakeAvailable: approved?.intakeAvailable ?? !!req,
      pending: !!req,
      reviewState: reviewMap[pk],
      profile: approved?.profile ?? req?.profile,
      media: approved?.media ?? req?.media,
      introText: approved?.introText ?? req?.message,
      statuses: coordStatuses.filter((s) => s.pubkey === pk),
      talks: talksFor,
    };
  });

  async function refreshCoordStatus() {
    if (!ctx?.config.coordinator || !keys?.eidNsecHex) return;
    coordStatuses = await fetchCoordinatorStatuses(ctx, keys.eidNsecHex).catch(() => []);
  }

  function dismissStatus(s: CoordinatorStatusContent) {
    dismissedStatuses = new Set([...dismissedStatuses, statusId(s)]);
    persistDismissed();
  }

  async function retryStatus(s: CoordinatorStatusContent) {
    if (!ctx?.config.coordinator) return;
    retryingStatus = statusId(s);
    error = null;
    try {
      // Per-attendee poison → reprocess that attendee; otherwise a full recompute.
      if (s.pubkey) {
        await sendAdminCommand(ctx, "reprocess", { pubkey: s.pubkey });
      } else {
        await sendAdminCommand(ctx, "recompute");
      }
      // Optimistically clear it locally; the coordinator publishes a fresh status
      // (poison again or cleared) once the retry runs.
      dismissStatus(s);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      retryingStatus = null;
    }
  }

  async function copyMyNpub() {
    if (!session.npub) return;
    await doCopy(session.npub, () => {
      copiedNpub = true;
      setTimeout(() => (copiedNpub = false), 1500);
    });
  }

  let inviteCount = $state(5);
  let invites = $state<GeneratedInvite[]>([]);
  let generating = $state(false);
  let showInviteSheet = $state(false);

  async function makeInvites() {
    if (!ctx || !session.signer) return;
    generating = true;
    error = null;
    try {
      const base = window.location.origin + window.location.pathname;
      invites = await generateInvites(session.signer, ctx, inviteCount, base);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      generating = false;
    }
  }

  async function copyLink(link: string) {
    await doCopy(link, () => {});
  }

  // Bulk export (user feedback 2026-07-22): mailing 200 invite links one at a
  // time by hand doesn't scale — one-per-line text for pasting into a mail-merge
  // tool, or the same as a downloadable file.
  let copiedAllLinks = $state(false);
  async function copyAllLinks() {
    await doCopy(invites.map((inv) => inv.link).join("\n"), () => {
      copiedAllLinks = true;
      setTimeout(() => (copiedAllLinks = false), 1500);
    });
  }
  function downloadLinksFile() {
    const text = invites.map((inv) => inv.link).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `nostrautica-invites-${naddr.slice(0, 12)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  let recomputing = $state(false);
  async function recomputeMatches() {
    if (!ctx?.config.coordinator) return;
    recomputing = true;
    error = null;
    try {
      await sendAdminCommand(ctx, "recompute");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      recomputing = false;
    }
  }

  async function reprocess(pubkey: string) {
    if (!ctx || !session.signer || !keys) return;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "reprocess", { pubkey });
      } else {
        // Re-process exists to pull in a submission that landed AFTER approval —
        // typically a text intro the attendee typed once they were in. approveAttendee
        // threads req.introText into the 31603 entry, so it must act on a FRESH
        // fetchPending: any in-memory copy predates that submission (this admin
        // page hasn't re-read the E_inbox since it loaded), and republishing the
        // stale req drops the new intro entirely (caching verification 2026-07-17:
        // this is why the e2e directory-loop marker never reached the attendee).
        // Fetch-fresh-before-publish, same as the other read-modify-write paths.
        const fresh = await fetchPending(ctx, keys);
        pending = mergePending(pending, fresh); // keep the queue in sync
        const latest = fresh.find((r) => r.attendeePubkey === pubkey);
        if (!latest) {
          // No fetchable intake for this roster member (UX-A1): nothing to
          // re-publish without a coordinator to recompute from stored state.
          error = t("admin.reprocess.noIntake");
          return;
        }
        await approveAttendee(session.signer, ctx, latest); // re-publishes the entry
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Approve one attendee by pubkey (coordinator command or local approve).
   *  Throws on failure so the bulk runner can record a per-item outcome. */
  async function approveOne(pubkey: string): Promise<void> {
    if (!ctx || !session.signer) throw new Error("not ready");
    if (ctx.config.coordinator) {
      // Route through the coordinator so IT grants + publishes the directory
      // (attendees discover directory/roster/matches under the coordinator key).
      await sendAdminCommand(ctx, "approve", { pubkey });
    } else {
      const req = pending.find((r) => r.attendeePubkey === pubkey);
      if (!req) throw new Error(t("admin.reprocess.noIntake"));
      await approveAttendee(session.signer, ctx, req);
    }
    approvedSet = new Set([...approvedSet, pubkey]);
  }

  // Per-request busy guard (audit UX-27): a double-tap must not fire two
  // approvals (two roster republishes racing latest-wins).
  let approving = $state<Set<string>>(new Set());
  async function approve(req: PendingRequest) {
    if (approving.has(req.attendeePubkey)) return;
    approving = new Set([...approving, req.attendeePubkey]);
    try {
      await approveOne(req.attendeePubkey);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      approving = new Set([...approving].filter((p) => p !== req.attendeePubkey));
    }
  }

  // Bulk approval with per-item status (UX-A4): queued → publishing → confirmed /
  // failed, with a final "N approved, M need retry" summary and individually
  // retryable failures.
  let approvingAll = $state(false);
  let bulkItems = $state<BulkItem[]>([]);
  let bulkRan = $state(false);
  const bulkSummary = $derived(summarizeBulk(bulkItems));

  function setBulk(pubkey: string, state: BulkItem["state"], errMsg?: string) {
    bulkItems = bulkItems.map((it) =>
      it.pubkey === pubkey ? { pubkey, state, error: errMsg } : it,
    );
  }

  async function approveAll() {
    approvingAll = true;
    bulkRan = true;
    bulkItems = pendingRequests.map((r) => ({ pubkey: r.attendeePubkey, state: "queued" as const }));
    try {
      for (const it of bulkItems) await runBulkItem(it.pubkey);
    } finally {
      approvingAll = false;
    }
  }

  async function runBulkItem(pubkey: string) {
    setBulk(pubkey, "publishing");
    try {
      await approveOne(pubkey);
      setBulk(pubkey, "confirmed");
    } catch (e) {
      setBulk(pubkey, "failed", e instanceof Error ? e.message : String(e));
    }
  }

  async function retryBulkItem(pubkey: string) {
    await runBulkItem(pubkey);
  }

  function bulkItemState(pubkey: string): BulkItem["state"] | undefined {
    return bulkItems.find((it) => it.pubkey === pubkey)?.state;
  }

  // Inline, screenshotable revoke confirmation lives in AdminPeople (which owns the
  // confirm state); the parent performs the revoke and updates its data model.
  async function revoke(pubkey: string) {
    if (!ctx || !session.signer) return;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "revoke", { pubkey });
      } else {
        await revokeAttendeeClient(session.signer, ctx, pubkey);
      }
      revokedSet = new Set([...revokedSet, pubkey]);
      approvedSet = new Set([...approvedSet].filter((p) => p !== pubkey));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function short(pk: string) {
    return pk.slice(0, 8) + "…" + pk.slice(-4);
  }

  // Event posts (spec §7.4): the PostEditor composer publishes public 30023
  // (exactly as updates, §7.1) or members-only 31607, chosen at creation.
  // Event posts (spec §7.4) now live in the AdminCommunicate domain component,
  // which owns the composer state, the post list, and the publish/edit actions.
</script>

<div class="row" style="justify-content:space-between;align-items:center">
  <h1 style="margin:0">{t("admin.title")}</h1>
  {#if ctx}
    <button class="btn inline" onclick={() => router.go({ name: "event", naddr })}>
      {t("admin.done")}
    </button>
  {/if}
</div>

<AdminTabs {naddr} />

{#if error}<div class="card warn">{error}</div>{/if}

{#if notOrganizer}
  <div class="card">
    <p><strong>{t("admin.notOrganizer.title")}</strong></p>
    <p class="muted">
      {t("admin.notOrganizer.body")}
    </p>
    <div class="field-label">{t("admin.yourNpub")}</div>
    <p class="mono">{session.npub}</p>
    <button class="btn inline" aria-live="polite" onclick={copyMyNpub}>
      {copiedNpub ? t("admin.copied") : t("admin.copyNpub")}
    </button>
    <ol class="muted" style="margin:0.75rem 0 0;padding-left:1.25rem">
      <li>{t("admin.grant.step1")}</li>
      <li>{t("admin.grant.step2")}</li>
      <li>{t("admin.grant.step3")}</li>
    </ol>
    <!-- Truthful wait state: this line used to read "Waiting for the grant…"
         unconditionally, with nothing behind it once the poll had bailed out. It
         now says which of the three real states the page is in, and the button
         gives a way out that doesn't require knowing to navigate away and back. -->
    <p class="muted" role="status" aria-live="polite" style="margin-top:0.5rem">
      {#if !session.signer}
        {t("admin.grant.waitingSigner")}
      {:else if grantWaiting}
        {t("admin.grant.waiting")}
      {:else}
        {t("admin.grant.notChecking")}
      {/if}
      {#if grantCheckedAt !== undefined}
        {t("admin.grant.lastChecked", {
          time: new Date(grantCheckedAt).toLocaleTimeString(),
        })}
      {/if}
    </p>
    <button class="btn inline" onclick={() => void checkGrantNow()} disabled={grantChecking}>
      {grantChecking ? t("admin.grant.checkingNow") : t("admin.grant.checkNow")}
    </button>
    {#if grantCheckError}
      <p class="muted" style="color:var(--danger);margin:0.5rem 0 0">{grantCheckError}</p>
    {/if}
  </div>
{:else if loading}
  <p class="muted">{t("admin.loading")}</p>
{:else}
  {#if refreshing}
    <!-- Subtle refresh affordance over the cached paint (§2.11) — not a spinner.
         "Refreshing…", not admin.loading ("Loading pending requests…"): the page
         is already painted, so the loading copy would be wrong over it. -->
    <p class="muted" role="status" aria-live="polite" style="font-size:0.8rem;margin:0 0 0.35rem">
      {t("admin.refreshing")}
    </p>
  {/if}
  <div class="row" style="justify-content:space-between">
    <button
      class="btn inline"
      onclick={scrollToRequests}
      disabled={pendingRequests.length === 0}
    >
      {tp("admin.pending", pendingRequests.length)}
    </button>
    <button class="btn inline" onclick={() => void refreshGuarded()}>{t("admin.refresh")}</button>
  </div>
  {#if lastRefreshed !== undefined}
    <!-- Data freshness shown distinctly from item state (UX-A2): "as of" is about
         when we last heard from relays, not about any one request's status. -->
    <p class="muted" style="font-size:0.75rem;margin:0 0 0.35rem">
      {t("admin.freshness", { ago: sinceLabel(lastRefreshed) })}
    </p>
  {/if}

  <!-- Operational overview (UX-A5): a control room, not just a control list —
       exceptions above the healthy detail. -->
  <AdminOverview exceptions={overview.exceptions} metrics={overview.metrics} />

  <!-- Operations first (§9): urgent join requests render above everything else,
       so a pending approval is visible without scrolling past setup/invite QR. -->
  <h2 class="section-head">{t("admin.section.operations")}</h2>

  {#if missingEidKey}
    <div class="card warn" style="margin-bottom:0.75rem">
      <strong>{t("admin.noEidKey.title")}</strong>
      <p class="muted" style="margin:0.25rem 0 0">{t("admin.noEidKey.body")}</p>
    </div>
  {/if}

  {#if !selfEnrolled && !missingEidKey}
    <div class="card" style="margin-bottom:0.75rem">
      <strong>{t("admin.enrollSelf.title")}</strong>
      <p class="muted" style="margin:0.25rem 0 0.5rem">{t("admin.enrollSelf.body")}</p>
      {#if enrollSent}
        <p class="muted" style="margin:0">{t("admin.enrollSelf.sent")}</p>
      {:else}
        <button class="btn inline primary" onclick={enrollSelf} disabled={enrollingSelf}>
          {enrollingSelf ? t("admin.enrollSelf.busy") : t("admin.enrollSelf.action")}
        </button>
      {/if}
      {#if enrollError}<p class="muted" style="color:var(--danger);margin:0.5rem 0 0">{enrollError}</p>{/if}
    </div>
  {/if}

  <!-- Coordinator operations (liveness · billing · recompute). Attaching /
       swapping a coordinator is one-time setup, so it lives on Event settings;
       here we surface only the running-event signals an organizer acts on. -->
  {#if ctx?.config.coordinator}
    <div class="card" style="margin-bottom:0.75rem">
      <div class="field-label">{t("admin.coordinator.title")}</div>
      <p class="muted">{t("admin.coordinator.attached")} <span class="mono">{ctx.config.coordinator.slice(0, 16)}…</span></p>
      <p class="muted" style="margin:0 0 0.5rem">
        <!-- Stale/unknown liveness is never green (§9). -->
        {#if !coordLivenessChecked && coordLastSeen === undefined}
          <span class="badge warn">{t("admin.checkingStatus")}</span>
        {:else if coordLastSeen === undefined}
          <span class="badge warn">{t("admin.coordinator.notSeen")}</span>
        {:else if coordStale}
          <span class="badge warn">{sinceLabel(coordLastSeen)}</span>
        {:else}
          <span class="badge ok">{sinceLabel(coordLastSeen)}</span>
        {/if}
        {#if coordStale}
          <span style="color:var(--danger)">{t("admin.coordinator.stale")}</span>
        {/if}
      </p>
      {#if billing}
        <div class="card warn" style="margin:0.5rem 0">
          <strong>
            {billing.state === "payment_required"
              ? t("admin.billing.required")
              : t("admin.billing.grace")}
          </strong>
          {#if billing.reason}<p class="muted" style="margin:0.25rem 0">{billing.reason}</p>{/if}
          {#if billingCheckoutUrl}
            <a class="btn inline primary" href={billingCheckoutUrl} target="_blank" rel="noopener noreferrer">
              {t("admin.billing.checkout")}
            </a>
          {/if}
        </div>
      {/if}
      <button class="btn inline" onclick={recomputeMatches} disabled={recomputing}>
        {recomputing ? t("admin.coordinator.recomputing") : t("admin.coordinator.recompute")}
      </button>
    </div>
  {:else}
    <div class="card" style="margin-bottom:0.75rem">
      <p class="muted" style="margin:0 0 0.5rem">{t("admin.coordinator.attachHint")}</p>
      <button class="btn inline" onclick={() => router.go({ name: "eventSettings", naddr })}>
        {t("admin.tab.settings")}
      </button>
    </div>
  {/if}

  {#if poisonStatuses.length}
    <div class="stack" style="margin-bottom:0.75rem">
      {#each poisonStatuses as s (statusId(s))}
        <div class="card" style="border-left:3px solid var(--danger)">
          <div class="row" style="justify-content:space-between;align-items:baseline">
            <strong>{t("admin.poison.title")}</strong>
            <span class="badge">{s.stage}</span>
          </div>
          <p class="muted" style="margin:0.25rem 0">
            {t("admin.poison.body", { stage: s.stage ?? "", attempts: s.attempts ?? 0 })}
          </p>
          {#if s.pubkey}
            <p class="muted" style="margin:0.25rem 0">
              {t("admin.poison.attendee")} <span class="badge">{short(s.pubkey)}</span>
            </p>
          {/if}
          <p class="muted" style="margin:0.25rem 0">
            {t("admin.poison.reason")} <span class="badge">{s.error_category}</span>
            {#if !s.retryable}<span class="badge">{t("admin.poison.notRetryable")}</span>{/if}
          </p>
          <div class="row">
            {#if s.retryable}
              <button
                class="btn inline primary"
                onclick={() => retryStatus(s)}
                disabled={retryingStatus === statusId(s)}
              >
                {retryingStatus === statusId(s) ? t("admin.poison.retrying") : t("admin.poison.retry")}
              </button>
            {/if}
            <button class="btn inline" onclick={() => dismissStatus(s)}>
              {t("admin.poison.dismiss")}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- People search + filter (UX-A6): narrows both the pending queue and the
       approved People list below by name/pubkey and by status. -->
  <div class="row" style="flex-wrap:wrap;gap:0.5rem;margin:0.75rem 0 0.25rem">
    <input
      type="search"
      bind:value={peopleQuery}
      placeholder={t("admin.people.search")}
      aria-label={t("admin.people.search")}
      style="flex:1;min-width:160px"
    />
    <select bind:value={peopleFilter} aria-label={t("admin.people.filter")}>
      <option value="all">{t("admin.people.filter.all")}</option>
      <option value="pending">{t("admin.people.filter.pending")}</option>
      <option value="approved">{t("admin.people.filter.approved")}</option>
      <option value="no-intro">{t("admin.people.filter.noIntro")}</option>
      <option value="failed">{t("admin.people.filter.failed")}</option>
      <option value="talk">{t("admin.people.filter.talk")}</option>
    </select>
  </div>
  {#if peopleFilterActive}
    <p class="muted" style="font-size:0.78rem;margin:0 0 0.35rem">
      {tp("admin.people.matchCount", filteredPeople.length)}
    </p>
  {/if}

  <AdminQueue
    requests={pendingRequests}
    filterActive={peopleFilterActive}
    {matchedPubkeys}
    {deferredSet}
    {rejectedSet}
    {approving}
    {approvingAll}
    {bulkRan}
    {bulkSummary}
    {bulkItemState}
    onApprove={approve}
    onApproveAll={approveAll}
    onReview={review}
    onRetryBulk={(pk) => void retryBulkItem(pk)}
    onDetails={(pk) => (detailPubkey = pk)}
  />

  <AdminPeople
    people={approvedPeople}
    filterActive={peopleFilterActive}
    {matchedPubkeys}
    onRevoke={revoke}
    onReprocess={reprocess}
    onDetails={(pk) => (detailPubkey = pk)}
  />

  {#if ctx && ctx.config.talks !== "off"}
    <AdminTalks
      {ctx}
      talks={visibleTalks}
      onModerated={(key) => (moderatedTalks = new Set([...moderatedTalks, key]))}
      onError={(msg) => (error = msg)}
    />
  {/if}

  {#if ctx}
    <AdminCommunicate
      {ctx}
      initialPosts={cachedEventPosts(ctx.coordinate) ?? []}
      onError={(msg) => (error = msg)}
    />
  {/if}

  <div class="card">
    <div class="field-label">{t("admin.invites.title")}</div>
    <p class="muted">
      {t("admin.invites.body")}
    </p>
    <div class="row">
      <input type="number" min="1" max="100" bind:value={inviteCount} style="max-width:5rem" />
      <button class="btn inline" onclick={makeInvites} disabled={generating}>
        {generating ? t("admin.invites.generating") : t("admin.invites.generate")}
      </button>
    </div>
    {#if invites.length > 0}
      <!-- §13.3: invite links embed single-use nsecs (and QR codes of them);
           suppress the organizer's event CSS while they're on screen so no
           31609 stylesheet can exfiltrate them. -->
      <SecretSurface>
        <div class="row" style="margin-top:0.5rem;gap:0.5rem;flex-wrap:wrap">
          {#if invites.length > 1}
            <button class="btn inline" onclick={copyAllLinks}>
              {copiedAllLinks ? t("admin.invites.copiedAll") : t("admin.invites.copyAll")}
            </button>
            <button class="btn inline" onclick={downloadLinksFile}>{t("admin.invites.download")}</button>
          {/if}
          <!-- Printable invite sheet (spec §13): QR per unused code, N per page. -->
          <button class="btn inline" onclick={() => (showInviteSheet = true)}>
            {t("admin.invites.printSheet")}
          </button>
        </div>
        {#if copyFailed}
          <p class="muted" role="status" style="margin:0.4rem 0 0;font-size:0.82rem">{t("common.copyFailed")}</p>
        {/if}
        {#each invites as inv (inv.nsec)}
          <div class="card" style="background:var(--bg-elev2)">
            <div class="row" style="justify-content:space-between">
              <span class="badge">{inv.label}</span>
              <button class="btn inline" onclick={() => copyLink(inv.link)}>{t("admin.invites.copyLink")}</button>
            </div>
            <QrCode data={inv.link} size={140} />
            <p class="mono">{inv.link}</p>
          </div>
        {/each}
      </SecretSurface>
    {/if}
  </div>

  {#if ctx}
    <div class="row" style="justify-content:space-between;gap:0.5rem">
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        >{window.location.origin + window.location.pathname}#/e/{naddr}/join</span
      >
      <button class="btn inline" style="flex:none" aria-live="polite" onclick={copyInviteLink}>
        {copiedLink ? t("admin.inviteLink.copied") : t("admin.inviteLink.copy")}
      </button>
      {#if typeof navigator !== "undefined" && navigator.share}
        <button
          class="btn inline"
          style="flex:none"
          onclick={() =>
            navigator
              .share({
                title: ctx?.title,
                url: `${window.location.origin}${window.location.pathname}#/e/${naddr}/join`,
              })
              .catch(() => {})}
        >
          {t("admin.share")}
        </button>
      {/if}
    </div>
  {/if}
{/if}

{#if detailProps}
  <AdminPersonDrawer {...detailProps} onClose={() => (detailPubkey = null)} />
{/if}

{#if showInviteSheet}
  <InviteSheet
    {invites}
    eventTitle={ctx?.title ?? ""}
    onClose={() => (showInviteSheet = false)}
  />
{/if}

<style>
  /* Section dividers for the ops-console grouping (§9). */
  .section-head {
    margin: 1.5rem 0 0.25rem;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
</style>
