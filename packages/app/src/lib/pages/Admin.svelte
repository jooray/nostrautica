<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import { fetchRoster, cachedRoster, receiveGrants } from "$lib/events/attendee.js";
  import {
    fetchPending,
    cachedPending,
    approveAttendee,
    fetchCoordinatorLastSeen,
    cachedCoordinatorLastSeen,
    generateInvites,
    revokeAttendeeClient,
    sendAdminCommand,
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
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import type { CoordinatorStatusContent } from "@nostrautica/protocol";
  import QrCode from "$lib/components/QrCode.svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { publishEventUpdate } from "$lib/events/updates.js";
  import {
    fetchEventPosts,
    cachedEventPosts,
    publishMembersPost,
    type EventPost,
    type PostVisibility,
  } from "$lib/events/posts.js";
  import PostEditor from "$lib/components/PostEditor.svelte";
  import AdminTabs from "$lib/components/AdminTabs.svelte";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let keys = $state<EventKeys | null>(null);
  let pending = $state<PendingRequest[]>([]);
  let approvedSet = $state<Set<string>>(new Set()); // approved this session
  let rosterApproved = $state<Set<string>>(new Set()); // approved per the roster
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
  const pendingRequests = $derived(
    pending.filter((p) => !isApprovedNow(p.attendeePubkey) && !revokedSet.has(p.attendeePubkey)),
  );
  const approvedRequests = $derived(
    pending.filter((p) => isApprovedNow(p.attendeePubkey) || revokedSet.has(p.attendeePubkey)),
  );

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
    const [freshPending, roster] = await Promise.all([
      fetchPending(ctx, keys),
      fetchRoster(ctx).catch(() => undefined),
    ]);
    pending = freshPending;
    // Cross-reference the roster so already-approved attendees don't show as pending.
    rosterApproved = new Set(roster?.attendees.map((a) => a.pubkey) ?? []);
    // Pending talk submissions (spec F2.3) — moderation needs a coordinator to
    // publish the 31610, so only fetch the queue when one is attached.
    pendingTalks =
      ctx.config.talks !== "off" && ctx.config.coordinator
        ? await fetchPendingTalks(ctx, keys).catch(() => [])
        : [];
  }

  // ── pending talk moderation (spec F2.3) ────────────────────────────────────
  let pendingTalks = $state<PendingTalk[]>([]);
  let moderatedTalks = $state<Set<string>>(new Set()); // acted-on this session
  let talkBusy = $state<string | null>(null);
  let previewingTalk = $state<string | null>(null);
  function tkKey(tk: PendingTalk): string {
    return `${tk.pubkey}:${tk.talkD}`;
  }
  const visibleTalks = $derived(pendingTalks.filter((tk) => !moderatedTalks.has(tkKey(tk))));

  async function moderateTalk(tk: PendingTalk, cmd: "talk_publish" | "talk_reject") {
    if (!ctx?.config.coordinator) return;
    const key = tkKey(tk);
    talkBusy = key;
    error = null;
    try {
      await sendAdminCommand(ctx, cmd, { pubkey: tk.pubkey, talk_d: tk.talkD });
      moderatedTalks = new Set([...moderatedTalks, key]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      talkBusy = null;
    }
  }

  function scrollToRequests() {
    document.getElementById("join-requests")?.scrollIntoView({ behavior: "smooth" });
  }

  async function copyInviteLink() {
    const link = `${window.location.origin}${window.location.pathname}#/e/${naddr}/join`;
    await navigator.clipboard.writeText(link);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 1500);
  }

  onMount(async () => {
    try {
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
        void pollForOrganizerGrant();
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
      await Promise.allSettled([refresh(), loadUpdates()]);
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
    pending = cachedPending(coord) ?? pending;
    rosterApproved = new Set(cachedRoster(coord)?.attendees.map((a) => a.pubkey) ?? [...rosterApproved]);
    pendingTalks = cachedPendingTalks(coord) ?? pendingTalks;
    coordStatuses = cachedCoordinatorStatuses(coord) ?? coordStatuses;
    coordLastSeen = cachedCoordinatorLastSeen(coord) ?? coordLastSeen;
    posts = cachedEventPosts(coord) ?? posts;
  }

  async function pollForOrganizerGrant() {
    if (!ctx || !session.signer) return;
    while (notOrganizer && !destroyed) {
      await new Promise((r) => setTimeout(r, 4000));
      if (destroyed) return;
      await receiveGrants(session.signer).catch(() => {});
      const k = await loadEventKeys(ctx.coordinate);
      if (k && k.role === "organizer") {
        keys = k;
        notOrganizer = false;
        loading = true;
        try {
          await refresh();
          await loadUpdates();
          void refreshLiveness();
        } finally {
          loading = false;
        }
        return;
      }
    }
  }

  async function refreshLiveness() {
    if (!ctx?.config.coordinator) return;
    coordLastSeen = await fetchCoordinatorLastSeen(ctx).catch(() => undefined);
    await refreshCoordStatus();
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
  let dismissedStatuses = $state<Set<string>>(new Set(loadDismissed()));
  let retryingStatus = $state<string | null>(null);

  function statusId(s: CoordinatorStatusContent): string {
    return `${s.a}${s.stage}${s.pubkey ?? ""}`;
  }

  function loadDismissed(): string[] {
    try {
      const raw = localStorage.getItem("nostrautica-coord-status-dismissed");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  function persistDismissed() {
    try {
      localStorage.setItem(
        "nostrautica-coord-status-dismissed",
        JSON.stringify([...dismissedStatuses]),
      );
    } catch {
      /* storage unavailable — dismissal stays in-memory only */
    }
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
    await navigator.clipboard.writeText(session.npub);
    copiedNpub = true;
    setTimeout(() => (copiedNpub = false), 1500);
  }

  let inviteCount = $state(5);
  let invites = $state<GeneratedInvite[]>([]);
  let generating = $state(false);

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
    await navigator.clipboard.writeText(link);
  }

  // Bulk export (user feedback 2026-07-22): mailing 200 invite links one at a
  // time by hand doesn't scale — one-per-line text for pasting into a mail-merge
  // tool, or the same as a downloadable file.
  let copiedAllLinks = $state(false);
  async function copyAllLinks() {
    await navigator.clipboard.writeText(invites.map((inv) => inv.link).join("\n"));
    copiedAllLinks = true;
    setTimeout(() => (copiedAllLinks = false), 1500);
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

  async function reprocess(req: PendingRequest) {
    if (!ctx || !session.signer || !keys) return;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "reprocess", { pubkey: req.attendeePubkey });
      } else {
        // Re-process exists to pull in a submission that landed AFTER approval —
        // typically a text intro the attendee typed once they were in. approveAttendee
        // threads req.introText into the 31603 entry, so it must act on a FRESH
        // fetchPending: the in-memory `req` predates that submission (this admin
        // page hasn't re-read the E_inbox since it loaded), and republishing the
        // stale req drops the new intro entirely (caching verification 2026-07-17:
        // this is why the e2e directory-loop marker never reached the attendee).
        // Fetch-fresh-before-publish, same as the other read-modify-write paths.
        const fresh = await fetchPending(ctx, keys);
        const latest = fresh.find((r) => r.attendeePubkey === req.attendeePubkey) ?? req;
        pending = fresh; // keep the rendered queue in sync with what we just re-read
        await approveAttendee(session.signer, ctx, latest); // re-publishes the entry
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  let approvingAll = $state(false);
  // Per-request busy guard (audit UX-27): a double-tap must not fire two
  // approvals (two roster republishes racing latest-wins).
  let approving = $state<Set<string>>(new Set());
  async function approveAll() {
    approvingAll = true;
    try {
      for (const req of pendingRequests) await approve(req);
    } finally {
      approvingAll = false;
    }
  }

  async function approve(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    if (approving.has(req.attendeePubkey)) return;
    approving = new Set([...approving, req.attendeePubkey]);
    try {
      if (ctx.config.coordinator) {
        // Route through the coordinator so IT grants + publishes the directory
        // (attendees discover directory/roster/matches under the coordinator key).
        await sendAdminCommand(ctx, "approve", { pubkey: req.attendeePubkey });
      } else {
        await approveAttendee(session.signer, ctx, req);
      }
      approvedSet = new Set([...approvedSet, req.attendeePubkey]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      approving = new Set([...approving].filter((p) => p !== req.attendeePubkey));
    }
  }

  // Inline, screenshotable revoke confirmation (no window.confirm) — the attendee
  // card swaps to the consequence copy + Revoke/Keep while this holds a pubkey.
  let confirmingRevoke = $state<string | null>(null);
  async function revoke(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    confirmingRevoke = null;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "revoke", { pubkey: req.attendeePubkey });
      } else {
        await revokeAttendeeClient(session.signer, ctx, req.attendeePubkey);
      }
      revokedSet = new Set([...revokedSet, req.attendeePubkey]);
      approvedSet = new Set([...approvedSet].filter((p) => p !== req.attendeePubkey));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function short(pk: string) {
    return pk.slice(0, 8) + "…" + pk.slice(-4);
  }

  // Event posts (spec §7.4): the PostEditor composer publishes public 30023
  // (exactly as updates, §7.1) or members-only 31607, chosen at creation.
  let posts = $state<EventPost[]>([]);
  let postTitle = $state("");
  let postSummary = $state("");
  let postImage = $state("");
  let postContent = $state("");
  let postVisibility = $state<PostVisibility>("public");
  let postEditing = $state<EventPost | null>(null); // null = new post
  let postBusy = $state(false);

  async function loadUpdates() {
    if (!ctx) return;
    posts = await fetchEventPosts(ctx).catch(() => []);
  }

  function startEdit(p: EventPost) {
    postEditing = p;
    postTitle = p.title;
    postSummary = p.summary ?? "";
    postImage = p.image ?? "";
    postContent = p.content;
    // Visibility is fixed at creation (spec §7.4) — reflected + locked in the editor.
    postVisibility = p.membersOnly ? "members" : "public";
  }

  function resetEditor() {
    postEditing = null;
    postTitle = "";
    postSummary = "";
    postImage = "";
    postContent = "";
    postVisibility = "public";
  }

  async function publishPost() {
    if (!ctx || !postTitle.trim() || !postContent.trim()) return;
    postBusy = true;
    error = null;
    try {
      const base = {
        d: postEditing?.d,
        publishedAt: postEditing?.publishedAt,
        title: postTitle.trim(),
        summary: postSummary.trim() || undefined,
        image: postImage.trim() || undefined,
        content: postContent,
      };
      if (postVisibility === "members") {
        await publishMembersPost(ctx, {
          ...base,
          // Optional attribution: which organizer wrote it (inside the ciphertext).
          author: postEditing ? postEditing.author : (session.pubkey ?? undefined),
        });
      } else {
        await publishEventUpdate(ctx, base);
      }
      resetEditor();
      posts = await fetchEventPosts(ctx).catch(() => []);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      postBusy = false;
    }
  }
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
    <p class="muted" style="margin-top:0.5rem">{t("admin.grant.waiting")}</p>
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
        {#if coordLastSeen === undefined}
          <span class="badge warn">{t("admin.checkingStatus")}</span>
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

  <h2 id="join-requests">{t("admin.requests.title")}</h2>
  <div class="stack">
    {#if pendingRequests.length === 0}
      <p class="muted">{t("admin.requests.none")}</p>
    {:else if pendingRequests.length > 1}
      <button class="btn" onclick={approveAll} disabled={approvingAll}>
        {approvingAll ? t("admin.requests.approving") : t("admin.requests.approveAll", { n: pendingRequests.length })}
      </button>
    {/if}
    {#each pendingRequests as req (req.attendeePubkey)}
      <div class="card">
        <strong>{req.name}</strong>
        <span class="badge">{short(req.attendeePubkey)}</span>
        {#if req.invite}<span class="badge">{t("admin.requests.invite")}</span>{/if}
        {#if req.message}<p class="muted">{req.message}</p>{/if}
        {#if req.profile?.skills?.length}
          <div class="row" style="flex-wrap:wrap">
            {#each req.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
          </div>
        {/if}
        {#if req.media?.length}<span class="badge">{tp("admin.requests.video", req.media.length)}</span>{/if}
        <button
          class="btn primary"
          onclick={() => approve(req)}
          disabled={approving.has(req.attendeePubkey)}
        >{t("admin.requests.approve")}</button>
      </div>
    {/each}
  </div>

  {#if approvedRequests.length}
    <h2 class="section-head">{t("admin.section.people")}</h2>
    <h2>{t("admin.approved.title", { n: approvedRequests.length })}</h2>
    <div class="stack">
      {#each approvedRequests as req (req.attendeePubkey)}
        <div class="card">
          <strong>{req.name}</strong>
          <span class="badge">{short(req.attendeePubkey)}</span>
          {#if req.media?.length}<span class="badge">{tp("admin.requests.video", req.media.length)}</span>{/if}
          {#if revokedSet.has(req.attendeePubkey)}
            <p class="muted">{t("admin.revoked")}</p>
          {:else if confirmingRevoke === req.attendeePubkey}
            <p class="muted" style="margin:0.25rem 0">
              {t("admin.revoke.confirm")}
            </p>
            <div class="row">
              <button class="btn inline danger" onclick={() => revoke(req)}>{t("admin.revoke.revoke")}</button>
              <button class="btn inline" onclick={() => (confirmingRevoke = null)}>{t("admin.revoke.keep")}</button>
            </div>
          {:else}
            <p class="muted">{t("admin.approvedTag")}</p>
            <div class="row">
              <button class="btn inline" onclick={() => reprocess(req)}>{t("admin.reprocess")}</button>
              <button
                class="btn inline danger"
                onclick={() => (confirmingRevoke = req.attendeePubkey)}
              >
                {t("admin.revoke.revoke")}
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if ctx && ctx.config.talks !== "off"}
    <h2 class="section-head">{t("admin.talks.mod.section")}</h2>
    <div class="card">
      <div class="field-label">{t("admin.talks.mod.title")}</div>
      {#if !ctx.config.coordinator}
        <!-- Publishing a talk's 31610 is a coordinator action (spec F2). Without one
             there's no publish path, so surface that instead of dead buttons. -->
        <p class="muted">{t("admin.talks.mod.needsCoordinator")}</p>
      {:else if visibleTalks.length === 0}
        <p class="muted">{t("admin.talks.mod.none")}</p>
      {:else}
        <p class="muted">{t("admin.talks.mod.body")}</p>
        <div class="stack">
          {#each visibleTalks as tk (tkKey(tk))}
            <div class="card" style="background:var(--bg-elev2)">
              <strong>{tk.title}</strong>
              <span class="badge">{short(tk.pubkey)}</span>
              {#if tk.revision > 0}
                <span class="badge">{t("admin.talks.mod.revision", { n: tk.revision })}</span>
              {/if}
              {#if tk.description}<p class="muted">{tk.description}</p>{/if}
              {#if previewingTalk === tkKey(tk)}
                <MediaPlayer descriptor={tk.media} />
              {:else}
                <button class="btn inline" onclick={() => (previewingTalk = tkKey(tk))}>
                  {t("admin.talks.mod.preview")}
                </button>
              {/if}
              <div class="row">
                <button
                  class="btn primary"
                  onclick={() => moderateTalk(tk, "talk_publish")}
                  disabled={talkBusy === tkKey(tk)}
                >
                  {t("admin.talks.mod.publish")}
                </button>
                <button
                  class="btn inline danger"
                  onclick={() => moderateTalk(tk, "talk_reject")}
                  disabled={talkBusy === tkKey(tk)}
                >
                  {t("admin.talks.mod.reject")}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <h2 class="section-head">{t("admin.section.communicate")}</h2>

  <div class="card">
    <div class="field-label">{t("admin.posts.title")}</div>
    <p class="muted">
      {t("admin.posts.body")}
    </p>
    <PostEditor
      bind:title={postTitle}
      bind:summary={postSummary}
      bind:image={postImage}
      bind:content={postContent}
      bind:visibility={postVisibility}
      editing={postEditing !== null}
      busy={postBusy}
      onsubmit={publishPost}
      oncancel={resetEditor}
    />
    {#if posts.length}
      <div class="stack" style="margin-top:0.75rem">
        {#each posts as p (p.d)}
          <div class="row" style="justify-content:space-between">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {p.locked ? t("post.locked.title") : p.title}
              {#if p.membersOnly}<span class="badge">{t("post.membersBadge")}</span>{/if}
              <span class="muted" style="font-size:0.75rem">
                · {new Date(p.publishedAt * 1000).toLocaleDateString()}
              </span>
            </span>
            {#if !p.locked}
              <button class="btn inline" style="flex:none" onclick={() => startEdit(p)}>
                {t("admin.posts.edit")}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

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
    {#if invites.length > 1}
      <div class="row" style="margin-top:0.5rem;gap:0.5rem;flex-wrap:wrap">
        <button class="btn inline" onclick={copyAllLinks}>
          {copiedAllLinks ? t("admin.invites.copiedAll") : t("admin.invites.copyAll")}
        </button>
        <button class="btn inline" onclick={downloadLinksFile}>{t("admin.invites.download")}</button>
      </div>
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
