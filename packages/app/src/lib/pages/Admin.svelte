<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import { fetchRoster, cachedRoster, receiveGrants } from "$lib/events/attendee.js";
  import {
    fetchPending,
    cachedPending,
    approveAttendee,
    attachCoordinator,
    fetchCoordinatorLastSeen,
    cachedCoordinatorLastSeen,
    generateInvites,
    revokeAttendeeClient,
    sendAdminCommand,
    addCoOrganizer,
    updateEventConfig,
    type PendingRequest,
    type GeneratedInvite,
  } from "$lib/events/organizer.js";
  import { fetchCoordinatorStatuses, cachedCoordinatorStatuses } from "$lib/events/coordinator-status.js";
  import { enrollOrganizerAsParticipant } from "$lib/events/create.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import {
    fetchCoordinators,
    cachedCoordinators,
    pricingLabel,
    checkoutUrlForEvent,
    type DiscoveredCoordinator,
  } from "$lib/events/coordinators.js";
  import { fetchPendingTalks, cachedPendingTalks, type PendingTalk } from "$lib/events/talks.js";
  import { perfMark } from "$lib/perf.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import type { CoordinatorStatusContent } from "@nostrautica/protocol";
  import { decode } from "nostr-tools/nip19";
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
  import {
    fetchEventPage,
    publishEventPage,
    postNaddr,
  } from "$lib/events/event-page.js";
  import { fetchEventTheme, publishEventTheme } from "$lib/events/theme.js";
  import { previewEventTheme, resyncEventTheme } from "$lib/events/theme-injector.js";
  import {
    utf8ByteLength,
    MAX_THEME_CSS_BYTES,
    type MergedMenuItem,
    type MergedSection,
  } from "@nostrautica/protocol";
  import PostEditor from "$lib/components/PostEditor.svelte";
  import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
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
  onDestroy(() => (destroyed = true));

  // Approved = anyone in the roster OR approved just now. Reading the roster makes
  // approval persist across refreshes (it's not just session state).
  function isApprovedNow(pubkey: string): boolean {
    return approvedSet.has(pubkey) || rosterApproved.has(pubkey);
  }
  const pendingRequests = $derived(
    pending.filter((p) => !isApprovedNow(p.attendeePubkey)),
  );
  const approvedRequests = $derived(
    pending.filter((p) => isApprovedNow(p.attendeePubkey)),
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

  async function refresh() {
    if (!ctx || !keys) return;
    pending = await fetchPending(ctx, keys);
    // Cross-reference the roster so already-approved attendees don't show as pending.
    const roster = await fetchRoster(ctx).catch(() => undefined);
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
      // approvals, pending talks, statuses, last-seen, updates, coordinators.
      paintFromCache();
      loading = false;
      perfMark("Admin", "cache-paint");
      // Then run all refreshes in parallel — they're independent — updating each
      // slice as it lands. The relay-only scan semantics are untouched.
      refreshing = true;
      await Promise.allSettled([
        refresh(),
        loadUpdates(),
        refreshLiveness(),
        !ctx.config.coordinator ? loadCoordinators() : Promise.resolve(),
      ]);
      refreshing = false;
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
    if (!ctx.config.coordinator) coordinators = cachedCoordinators() ?? coordinators;
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

  let coordinatorInput = $state("");
  let attaching = $state(false);
  let attached = $state(false);

  // Prerecorded-talks mode (spec F2). Editing republishes the 31600 config; the
  // coordinator picks up the change live (audit H5). Seeded from the loaded config.
  let talksMode = $state<"off" | "on" | "prerecord-first">("off");
  let savingTalks = $state(false);
  let talksSaved = $state(false);
  $effect(() => {
    if (ctx) talksMode = ctx.config.talks;
  });
  async function saveTalks() {
    if (!ctx) return;
    savingTalks = true;
    talksSaved = false;
    error = null;
    try {
      await updateEventConfig(ctx, { talks: talksMode });
      ctx = { ...ctx, config: { ...ctx.config, talks: talksMode } };
      talksSaved = true;
      setTimeout(() => (talksSaved = false), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      savingTalks = false;
    }
  }

  // Marmot group chat (experimental). Operative only with a coordinator; toggling
  // it on later makes the coordinator backfill adds for all approved attendees.
  let chatEnabled = $state(false);
  let savingChat = $state(false);
  let chatSaved = $state(false);
  $effect(() => {
    if (ctx) chatEnabled = ctx.config.chat.includes("marmot");
  });
  async function saveChat() {
    if (!ctx) return;
    savingChat = true;
    chatSaved = false;
    error = null;
    try {
      const chat: ("marmot")[] = chatEnabled ? ["marmot"] : [];
      await updateEventConfig(ctx, { chat });
      ctx = { ...ctx, config: { ...ctx.config, chat } };
      chatSaved = true;
      setTimeout(() => (chatSaved = false), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      savingChat = false;
    }
  }

  // Discovered coordinators (kind 31611) — pick one instead of pasting an npub.
  let coordinators = $state<DiscoveredCoordinator[]>([]);
  let loadingCoordinators = $state(false);
  async function loadCoordinators() {
    loadingCoordinators = true;
    try {
      coordinators = await fetchCoordinators();
    } catch {
      coordinators = [];
    } finally {
      loadingCoordinators = false;
    }
  }

  async function attachPubkey(pubkey: string) {
    if (!ctx || !session.signer) return;
    attaching = true;
    error = null;
    try {
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error(t("admin.error.enterNpub"));
      await attachCoordinator(session.signer, ctx, pubkey);
      attached = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      attaching = false;
    }
  }

  async function attach() {
    if (!coordinatorInput.trim()) return;
    let pubkey = coordinatorInput.trim();
    if (pubkey.startsWith("npub1")) {
      try {
        const decoded = decode(pubkey);
        if (decoded.type !== "npub") throw new Error();
        pubkey = decoded.data;
      } catch {
        error = t("admin.error.badNpub");
        return;
      }
    }
    await attachPubkey(pubkey);
  }

  let coOrgInput = $state("");
  let addingCoOrg = $state(false);
  let coOrgAdded = $state(false);
  async function addCoOrg() {
    if (!ctx || !session.signer || !coOrgInput.trim()) return;
    addingCoOrg = true;
    error = null;
    try {
      let pubkey = coOrgInput.trim();
      if (pubkey.startsWith("npub1")) {
        const decoded = decode(pubkey);
        if (decoded.type !== "npub") throw new Error(t("admin.error.badNpub"));
        pubkey = decoded.data;
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error(t("admin.error.enterNpub"));
      await addCoOrganizer(session.signer, ctx, pubkey);
      coOrgAdded = true;
      coOrgInput = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      addingCoOrg = false;
    }
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
    if (!ctx || !session.signer) return;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "reprocess", { pubkey: req.attendeePubkey });
      } else {
        await approveAttendee(session.signer, ctx, req); // re-publishes the entry
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  let approvingAll = $state(false);
  async function approveAll() {
    approvingAll = true;
    try {
      for (const req of pendingRequests) await approve(req);
    } finally {
      approvingAll = false;
    }
  }

  async function approve(req: PendingRequest) {
    console.debug("[DEBUG approve] called", { hasCtx: !!ctx, hasSigner: !!session.signer, pubkey: req.attendeePubkey });
    if (!ctx || !session.signer) return;
    try {
      if (ctx.config.coordinator) {
        // Route through the coordinator so IT grants + publishes the directory
        // (attendees discover directory/roster/matches under the coordinator key).
        await sendAdminCommand(ctx, "approve", { pubkey: req.attendeePubkey });
      } else {
        await approveAttendee(session.signer, ctx, req);
      }
      console.debug("[DEBUG approve] success, adding to approvedSet", req.attendeePubkey);
      approvedSet = new Set([...approvedSet, req.attendeePubkey]);
      console.debug("[DEBUG approve] approvedSet now", [...approvedSet]);
    } catch (e) {
      console.debug("[DEBUG approve] threw", e);
      error = e instanceof Error ? e.message : String(e);
    }
  }

  let revokedSet = $state<Set<string>>(new Set());
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
    await loadEventPage();
    await loadTheme();
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

  // Menu & layout (spec §7.4 kind 31608): merged model, split on publish.
  let pageMenu = $state<MergedMenuItem[]>([]);
  let pageSections = $state<MergedSection[]>([]);
  let pageLoaded = $state(false);
  let pageBusy = $state(false);
  let pageSaved = $state(false);
  let menuLabel = $state("");
  let menuTarget = $state(""); // https URL, or nostr:naddr from the post picker
  let menuMembers = $state(false);

  async function loadEventPage() {
    if (!ctx) return;
    const page = await fetchEventPage(ctx).catch(() => undefined);
    pageMenu = page?.menu ?? [];
    pageSections = page?.sections ?? [];
    pageLoaded = true;
  }

  function addMenuItem() {
    const label = menuLabel.trim();
    const target = menuTarget.trim();
    if (!label || !target) return;
    pageMenu = [...pageMenu, { label, target, membersOnly: menuMembers }];
    menuLabel = "";
    menuTarget = "";
    menuMembers = false;
  }

  /** The post picker fills the target field with this event's post naddr. */
  function pickPostTarget(post: EventPost) {
    if (!ctx) return;
    menuTarget = `nostr:${postNaddr(ctx, post)}`;
    if (!menuLabel.trim() && post.title) menuLabel = post.title;
    if (post.membersOnly) menuMembers = true; // sensible default, still editable
  }

  function move<T>(list: T[], index: number, delta: number): T[] {
    const to = index + delta;
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    return next;
  }

  function addSection(type: "posts" | "pinned" | "attendees") {
    const section: MergedSection =
      type === "posts"
        ? { type, source: "event", visibility: "both", membersOnly: false }
        : type === "pinned"
          ? { type, refs: [], membersOnly: false }
          : { type, membersOnly: true }; // roster preview renders only for members
    pageSections = [...pageSections, section];
  }

  function pinPost(sectionIndex: number, post: EventPost) {
    if (!ctx) return;
    const section = pageSections[sectionIndex];
    if (section.type !== "pinned") return;
    const naddrRef = postNaddr(ctx, post);
    if (section.refs.includes(naddrRef)) return;
    pageSections = pageSections.map((s, i) =>
      i === sectionIndex && s.type === "pinned" ? { ...s, refs: [...s.refs, naddrRef] } : s,
    );
  }

  async function savePage() {
    if (!ctx) return;
    pageBusy = true;
    pageSaved = false;
    error = null;
    try {
      await publishEventPage(ctx, { menu: pageMenu, sections: pageSections });
      pageSaved = true;
      setTimeout(() => (pageSaved = false), 2000);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      pageBusy = false;
    }
  }

  // Appearance (spec §7.4 kind 31609): CSS editor with live preview.
  let themeCss = $state("");
  let themeBusy = $state(false);
  let themePublished = $state(false);
  let themePreviewing = $state(false);
  const themeBytes = $derived(utf8ByteLength(themeCss));
  const themeOver = $derived(themeBytes > MAX_THEME_CSS_BYTES);

  async function loadTheme() {
    if (!ctx) return;
    themeCss = (await fetchEventTheme(ctx).catch(() => undefined)) ?? "";
  }

  function previewTheme() {
    previewEventTheme(naddr, themeCss);
    themePreviewing = true;
  }

  async function stopPreview() {
    themePreviewing = false;
    await resyncEventTheme(naddr).catch(() => {});
  }

  async function publishTheme() {
    if (!ctx || themeOver) return;
    themeBusy = true;
    error = null;
    try {
      await publishEventTheme(ctx, themeCss);
      previewEventTheme(naddr, themeCss); // published = what you see
      themePreviewing = false;
      themePublished = true;
      setTimeout(() => (themePublished = false), 2000);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      themeBusy = false;
    }
  }

  onDestroy(() => {
    // Leaving Admin with an unsaved preview: restore the published theme.
    if (themePreviewing) void resyncEventTheme(naddr).catch(() => {});
  });
</script>

<div class="row" style="justify-content:space-between;align-items:center">
  <h1 style="margin:0">{t("admin.title")}</h1>
  {#if ctx}
    <button class="btn inline" onclick={() => router.go({ name: "event", naddr })}>
      {t("admin.done")}
    </button>
  {/if}
</div>

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
    <!-- Subtle refresh affordance over the cached paint (§2.11) — not a spinner. -->
    <p class="muted" role="status" aria-live="polite" style="font-size:0.8rem;margin:0 0 0.35rem">
      {t("admin.loading")}
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
    <button class="btn inline" onclick={refresh}>{t("admin.refresh")}</button>
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
        <button class="btn primary" onclick={() => approve(req)}>{t("admin.requests.approve")}</button>
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

  <h2 class="section-head">{t("admin.section.setup")}</h2>

  <div class="card">
    <div class="field-label">{t("admin.page.title")}</div>
    <p class="muted">{t("admin.page.body")}</p>

    <div class="field-label" style="margin-top:0.5rem">{t("admin.page.menu")}</div>
    {#if pageMenu.length}
      <div class="stack" style="margin-bottom:0.5rem">
        {#each pageMenu as item, i (i)}
          <div class="row" style="justify-content:space-between;align-items:center">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {item.label}
              {#if item.membersOnly}<span class="badge">{t("post.membersBadge")}</span>{/if}
              <span class="muted mono" style="font-size:0.7rem">{item.target.slice(0, 32)}…</span>
            </span>
            <span class="row" style="flex:none;gap:0.25rem">
              <button class="btn inline" aria-label={t("admin.page.moveUp")} onclick={() => (pageMenu = move(pageMenu, i, -1))}>↑</button>
              <button class="btn inline" aria-label={t("admin.page.moveDown")} onclick={() => (pageMenu = move(pageMenu, i, 1))}>↓</button>
              <button class="btn inline danger" onclick={() => (pageMenu = pageMenu.filter((_, j) => j !== i))}>✕</button>
            </span>
          </div>
        {/each}
      </div>
    {/if}
    <input placeholder={t("admin.page.labelPlaceholder")} bind:value={menuLabel} />
    <input
      placeholder={t("admin.page.targetPlaceholder")}
      bind:value={menuTarget}
      style="margin-top:0.5rem"
    />
    {#if posts.filter((p) => !p.locked).length}
      <details style="margin-top:0.5rem">
        <summary class="muted">{t("admin.page.pickPost")}</summary>
        <div class="stack" style="margin-top:0.25rem">
          {#each posts.filter((p) => !p.locked) as p (p.d)}
            <button class="btn inline" onclick={() => pickPostTarget(p)}>
              {p.title}
              {#if p.membersOnly}<Icon name="lock" size={14} />{/if}
            </button>
          {/each}
        </div>
      </details>
    {/if}
    <label class="row" style="margin-top:0.5rem;gap:0.5rem;align-items:center">
      <input type="checkbox" bind:checked={menuMembers} style="width:auto" />
      <span>{t("admin.page.membersOnlyItem")}</span>
    </label>
    <button
      class="btn inline"
      style="margin-top:0.5rem"
      onclick={addMenuItem}
      disabled={!menuLabel.trim() || !menuTarget.trim()}
    >
      {t("admin.page.addItem")}
    </button>

    <div class="field-label" style="margin-top:1rem">{t("admin.page.sections")}</div>
    <p class="muted" style="margin:0 0 0.5rem">{t("admin.page.sections.body")}</p>
    {#if pageSections.length}
      <div class="stack" style="margin-bottom:0.5rem">
        {#each pageSections as section, i (i)}
          <div class="card" style="background:var(--bg-elev2)">
            <div class="row" style="justify-content:space-between;align-items:center">
              <strong>
                {section.type === "posts"
                  ? t("admin.page.type.posts")
                  : section.type === "pinned"
                    ? t("admin.page.type.pinned")
                    : t("admin.page.type.attendees")}
                {#if section.membersOnly}<span class="badge">{t("post.membersBadge")}</span>{/if}
              </strong>
              <span class="row" style="flex:none;gap:0.25rem">
                <button class="btn inline" aria-label={t("admin.page.moveUp")} onclick={() => (pageSections = move(pageSections, i, -1))}>↑</button>
                <button class="btn inline" aria-label={t("admin.page.moveDown")} onclick={() => (pageSections = move(pageSections, i, 1))}>↓</button>
                <button class="btn inline danger" onclick={() => (pageSections = pageSections.filter((_, j) => j !== i))}>✕</button>
              </span>
            </div>
            {#if section.type === "posts"}
              <div class="row" style="flex-wrap:wrap">
                <label class="stack" style="gap:0.25rem">
                  <span class="muted">{t("posts.filter.source")}</span>
                  <select bind:value={section.source}>
                    <option value="event">{t("posts.filter.source.event")}</option>
                    <option value="attendees">{t("posts.filter.source.attendees")}</option>
                    <option value="both">{t("posts.filter.both")}</option>
                  </select>
                </label>
                <label class="stack" style="gap:0.25rem">
                  <span class="muted">{t("posts.filter.visibility")}</span>
                  <select bind:value={section.visibility}>
                    <option value="public">{t("post.editor.public")}</option>
                    <option value="members">{t("post.editor.members")}</option>
                    <option value="both">{t("posts.filter.both")}</option>
                  </select>
                </label>
              </div>
            {:else if section.type === "pinned"}
              {#if section.refs.length}
                <div class="stack" style="margin:0.25rem 0">
                  {#each section.refs as ref, r (ref)}
                    <div class="row" style="justify-content:space-between">
                      <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.7rem">{ref.slice(0, 40)}…</span>
                      <button
                        class="btn inline danger"
                        style="flex:none"
                        onclick={() =>
                          (pageSections = pageSections.map((s, j) =>
                            j === i && s.type === "pinned"
                              ? { ...s, refs: s.refs.filter((_, k) => k !== r) }
                              : s,
                          ))}
                      >
                        ✕
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if posts.filter((p) => !p.locked).length}
                <details>
                  <summary class="muted">{t("admin.page.pinPost")}</summary>
                  <div class="stack" style="margin-top:0.25rem">
                    {#each posts.filter((p) => !p.locked) as p (p.d)}
                      <button class="btn inline" onclick={() => pinPost(i, p)}>
                        {p.title}
                        {#if p.membersOnly}<Icon name="lock" size={14} />{/if}
                      </button>
                    {/each}
                  </div>
                </details>
              {/if}
            {:else}
              <p class="muted" style="margin:0.25rem 0 0">{t("admin.page.attendees.hint")}</p>
            {/if}
            <label class="row" style="margin-top:0.5rem;gap:0.5rem;align-items:center">
              <input type="checkbox" bind:checked={section.membersOnly} style="width:auto" />
              <span>{t("admin.page.membersOnlySection")}</span>
            </label>
          </div>
        {/each}
      </div>
    {/if}
    <div class="row" style="flex-wrap:wrap">
      <button class="btn inline" onclick={() => addSection("posts")}><Icon name="plus" size={15} /> {t("admin.page.type.posts")}</button>
      <button class="btn inline" onclick={() => addSection("pinned")}><Icon name="plus" size={15} /> {t("admin.page.type.pinned")}</button>
      <button class="btn inline" onclick={() => addSection("attendees")}><Icon name="plus" size={15} /> {t("admin.page.type.attendees")}</button>
    </div>
    <div class="row" style="margin-top:0.75rem">
      <button class="btn inline primary" onclick={savePage} disabled={pageBusy || !pageLoaded}>
        {pageBusy ? t("admin.page.saving") : t("admin.page.save")}
      </button>
      {#if pageSaved}<span class="muted">{t("admin.page.saved")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.theme.title")}</div>
    <p class="muted">{t("admin.theme.body")}</p>
    <textarea
      rows="8"
      class="mono"
      placeholder={t("admin.theme.placeholder")}
      bind:value={themeCss}
    ></textarea>
    <p class="muted" style="margin:0.25rem 0" class:danger-text={themeOver}>
      {t("admin.theme.byteCount", { used: themeBytes, max: MAX_THEME_CSS_BYTES })}
      {#if themeOver}— {t("admin.theme.tooBig")}{/if}
    </p>
    <div class="row">
      <button class="btn inline" onclick={previewTheme} disabled={themeOver}>
        {t("admin.theme.preview")}
      </button>
      {#if themePreviewing}
        <button class="btn inline" onclick={stopPreview}>{t("admin.theme.stopPreview")}</button>
      {/if}
      <button class="btn inline primary" onclick={publishTheme} disabled={themeBusy || themeOver}>
        {themeBusy ? t("admin.theme.publishing") : t("admin.theme.publish")}
      </button>
      {#if themePublished}<span class="muted">{t("admin.theme.published")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.coordinator.title")}</div>
    {#if ctx?.config.coordinator}
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
    {:else if attached}
      <p class="muted">{t("admin.coordinator.attachedOk")}</p>
    {:else}
      <p class="muted">
        {t("admin.coordinator.body")}
      </p>

      <!-- Discovered coordinators (kind 31611) — pick one, no npub needed. -->
      {#if loadingCoordinators}
        <p class="muted">{t("admin.coordinator.discovering")}</p>
      {:else if coordinators.length}
        <div class="stack" style="gap:0.5rem;margin:0.5rem 0">
          {#each coordinators as c (c.pubkey)}
            <div class="card coord-card">
              <div class="row" style="gap:0.6rem;align-items:flex-start">
                {#if c.announce.picture}
                  <img src={c.announce.picture} alt="" class="coord-logo" />
                {/if}
                <div style="flex:1;min-width:0">
                  <strong>{c.announce.name}</strong>
                  <span class="badge">{pricingLabel(c.announce)}</span>
                  {#if c.announce.about}
                    <p class="muted" style="margin:0.2rem 0 0;font-size:0.85rem">{c.announce.about}</p>
                  {/if}
                  <div class="row" style="flex-wrap:wrap;gap:0.3rem;margin-top:0.35rem">
                    {#if c.announce.features?.matching}<span class="badge">{t("admin.coordinator.feat.matching")}</span>{/if}
                    {#if c.announce.features?.talks}<span class="badge">{t("admin.coordinator.feat.talks")}</span>{/if}
                    {#if c.announce.features?.chat?.length}<span class="badge">{t("admin.coordinator.feat.chat")}</span>{/if}
                    {#if c.announce.privacy}
                      {#each Object.entries(c.announce.privacy).filter(([, v]) => v !== "private") as [role] (role)}
                        <span class="badge warn">{role}: {t("admin.coordinator.nonPrivate")}</span>
                      {/each}
                    {/if}
                  </div>
                  <p class="muted mono" style="margin:0.35rem 0 0;font-size:0.72rem">{c.npub.slice(0, 20)}…</p>
                </div>
              </div>
              <div class="row" style="margin-top:0.5rem;gap:0.5rem;flex-wrap:wrap">
                {#if c.announce.terms_url}
                  <a class="btn inline" href={c.announce.terms_url} target="_blank" rel="noopener noreferrer">{t("admin.coordinator.terms")}</a>
                {/if}
                <button class="btn inline primary" onclick={() => attachPubkey(c.pubkey)} disabled={attaching}>
                  {attaching ? t("admin.coordinator.attaching") : t("admin.coordinator.attachThis")}
                </button>
              </div>
            </div>
          {/each}
        </div>
        <p class="muted" style="margin:0.5rem 0 0;font-size:0.8rem">{t("admin.coordinator.unverified")}</p>
      {/if}

      <!-- Advanced / fallback: paste an npub directly. -->
      <details style="margin-top:0.5rem">
        <summary class="muted" style="cursor:pointer">{t("admin.coordinator.paste")}</summary>
        <input style="margin-top:0.5rem" placeholder={t("admin.coordinator.placeholder")} bind:value={coordinatorInput} />
        <button class="btn" style="margin-top:0.5rem" onclick={attach} disabled={attaching}>
          {attaching ? t("admin.coordinator.attaching") : t("admin.coordinator.attach")}
        </button>
      </details>
    {/if}
  </div>

  <div class="card">
    <div class="field-label">{t("admin.talks.title")}</div>
    <p class="muted">{t("admin.talks.body")}</p>
    <select bind:value={talksMode}>
      <option value="off">{t("create.talks.off")}</option>
      <option value="on">{t("create.talks.on")}</option>
      <option value="prerecord-first">{t("create.talks.prerecordFirst")}</option>
    </select>
    <div class="row" style="margin-top:0.5rem">
      <button class="btn inline" onclick={saveTalks} disabled={savingTalks || talksMode === ctx?.config.talks}>
        {savingTalks ? t("admin.talks.saving") : t("admin.talks.save")}
      </button>
      {#if talksSaved}<span class="muted">{t("admin.talks.saved")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">
      {t("chat.toggle.label")} <span class="badge">{t("chat.toggle.experimental")}</span>
    </div>
    <p class="muted">{t("chat.toggle.help")}</p>
    <ToggleSwitch bind:checked={chatEnabled} disabled={!ctx?.config.coordinator}>
      {t("chat.toggle.label")}
    </ToggleSwitch>
    {#if !ctx?.config.coordinator}
      <p class="muted" style="margin-top:0.35rem">{t("chat.toggle.needsCoordinator")}</p>
    {/if}
    <div class="row" style="margin-top:0.5rem">
      <button
        class="btn inline"
        onclick={saveChat}
        disabled={savingChat || !ctx?.config.coordinator || chatEnabled === (ctx?.config.chat.includes("marmot") ?? false)}
      >
        {savingChat ? t("admin.talks.saving") : t("admin.talks.save")}
      </button>
      {#if chatSaved}<span class="muted">{t("admin.talks.saved")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.coorg.title")}</div>
    <p class="muted">
      {t("admin.coorg.body")}
    </p>
    <input placeholder={t("admin.coorg.placeholder")} bind:value={coOrgInput} />
    <div class="row" style="margin-top:0.5rem">
      <button class="btn inline" onclick={addCoOrg} disabled={addingCoOrg || !coOrgInput.trim()}>
        {addingCoOrg ? t("admin.coorg.adding") : t("admin.coorg.add")}
      </button>
      {#if coOrgAdded}<span class="muted">{t("admin.coorg.sent")}</span>{/if}
    </div>
  </div>

{/if}

<style>
  .danger-text {
    color: var(--danger);
  }
  /* Section dividers for the ops-console grouping (§9). */
  .section-head {
    margin: 1.5rem 0 0.25rem;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .coord-card {
    background: var(--bg-elev2, transparent);
  }
  .coord-logo {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    object-fit: cover;
    flex: none;
  }
</style>
