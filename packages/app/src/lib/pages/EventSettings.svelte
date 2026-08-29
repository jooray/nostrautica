<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import FileButton from "$lib/components/FileButton.svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk, isAcceptedRelayUrl } from "$lib/nostr/ndk.js";
  import { unionRelays, chatInteropRelays, chatRelaysOf } from "$lib/nostr/relays.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import { receiveGrants } from "$lib/events/attendee.js";
  import {
    attachCoordinator,
    detachCoordinator,
    addCoOrganizer,
    updateEventConfig,
    fetchCoordinatorLastSeen,
    checkForOrganizerGrant,
    pollForOrganizerGrant,
  } from "$lib/events/organizer.js";
  import { fetchCoordinatorStatuses } from "$lib/events/coordinator-status.js";
  import { updateEventMetadata } from "$lib/events/event-metadata.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import {
    fetchCoordinators,
    cachedCoordinators,
    pricingLabel,
    httpsUrl,
    type DiscoveredCoordinator,
  } from "$lib/events/coordinators.js";
  import { perfMark } from "$lib/perf.js";
  import { decode, npubEncode } from "nostr-tools/nip19";
  import { router } from "$lib/router/router.svelte.js";
  import {
    fetchEventPosts,
    cachedEventPosts,
    type EventPost,
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
    MAX_FEED_SOURCES,
    MAX_FEED_TAGS,
    type ExternalFeed,
    type MergedMenuItem,
    type MergedSection,
  } from "@nostrautica/protocol";
  import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
  import ImageCropper from "$lib/components/ImageCropper.svelte";
  import { defaultEventBanner, defaultEventIcon, uploadPublicImage } from "$lib/media/image.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { opStatus } from "$lib/stores/op-status.svelte.js";
  import { copyText } from "$lib/util/clipboard.js";
  import AdminTabs from "$lib/components/AdminTabs.svelte";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { saveDraft, loadDraft, clearDraft } from "$lib/stores/drafts.js";

  let { naddr }: { naddr: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let keys = $state<EventKeys | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notOrganizer = $state(false);
  let missingEidKey = $state(false); // organizer role but no E_id secret on this device
  let copiedNpub = $state(false);
  let destroyed = false;

  // Posts are read-only here — the menu/layout editor picks them as targets or
  // pins them. Composing/editing posts lives on the Administration page.
  let posts = $state<EventPost[]>([]);

  // Public NIP-52 metadata. Saving republishes the same addressable event, so
  // the coordinate and every existing invite/share link remain unchanged.
  let metadataTitle = $state("");
  let metadataSummary = $state("");
  let metadataStart = $state("");
  let metadataEnd = $state("");
  let metadataLocation = $state("");
  let metadataIcon = $state("");
  let metadataBanner = $state("");
  let metadataSeededFor = $state<string | null>(null);
  let metadataBusy = $state(false);
  let metadataSaved = $state(false);
  let metadataUploading = $state<"icon" | "banner" | null>(null);
  let metadataCropFile = $state<File | null>(null);
  let metadataCropWhich = $state<"icon" | "banner">("icon");
  const metadataPreviewIcon = $derived(
    metadataIcon.trim() || defaultEventIcon(metadataTitle, metadataTitle),
  );
  const metadataPreviewBanner = $derived(
    metadataBanner.trim() || defaultEventBanner(metadataTitle),
  );
  const metadataEndBeforeStart = $derived(
    !!metadataEnd &&
      !!metadataStart &&
      new Date(metadataEnd).getTime() <= new Date(metadataStart).getTime(),
  );

  function localDateTime(unix?: number): string {
    if (!unix) return "";
    const date = new Date(unix * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  $effect(() => {
    if (!ctx || metadataSeededFor === ctx.coordinate) return;
    metadataTitle = ctx.title;
    metadataSummary = ctx.summary;
    metadataStart = localDateTime(ctx.start);
    metadataEnd = localDateTime(ctx.end);
    metadataLocation = ctx.location ?? "";
    metadataIcon = ctx.icon ?? "";
    metadataBanner = ctx.banner ?? "";
    metadataSeededFor = ctx.coordinate;
  });

  function pickMetadataImage(e: Event, which: "icon" | "banner") {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    metadataCropWhich = which;
    metadataCropFile = file;
  }

  async function uploadMetadataImage(blob: Blob) {
    if (!ctx || !session.signer) return;
    const which = metadataCropWhich;
    metadataCropFile = null;
    metadataUploading = which;
    error = null;
    try {
      const url = await uploadPublicImage(session.signer, blob, ctx.config.blossom);
      if (which === "icon") metadataIcon = url;
      else metadataBanner = url;
    } catch (e) {
      error = t("create.error.uploadFailed", {
        reason: e instanceof Error ? e.message : String(e),
      });
    } finally {
      metadataUploading = null;
    }
  }

  async function saveMetadata() {
    if (!ctx || !metadataTitle.trim() || !metadataStart) return;
    if (metadataEndBeforeStart) {
      error = t("create.error.endBeforeStart");
      return;
    }
    metadataBusy = true;
    metadataSaved = false;
    error = null;
    try {
      const { ctx: updated, outcome } = await updateEventMetadata(ctx, {
        title: metadataTitle.trim(),
        summary: metadataSummary.trim(),
        start: Math.floor(new Date(metadataStart).getTime() / 1000),
        end: metadataEnd ? Math.floor(new Date(metadataEnd).getTime() / 1000) : undefined,
        location: metadataLocation.trim() || undefined,
        icon: metadataIcon.trim() || undefined,
        banner: metadataBanner.trim() || undefined,
      });
      ctx = updated;
      recentEvents.record({
        coordinate: ctx.coordinate,
        naddr: ctx.naddr,
        title: ctx.title,
        icon: ctx.icon,
        role: "organizer",
      });
      // R9: distinguish a relay-confirmed publish from a WSS-blocked queue. The
      // inline "Saved ✓" tick shows only on a real publish; either way the honest
      // status line tells the organizer whether attendees can see the change yet.
      if (outcome === "queued") {
        opStatus.queued(t("op.eventUpdateQueued"));
      } else {
        opStatus.published(t("op.eventUpdated"));
        metadataSaved = true;
        setTimeout(() => (metadataSaved = false), 1500);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      metadataBusy = false;
    }
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
      // Seed read-only slices from cache for an instant paint, then refresh.
      if (!ctx.config.coordinator) coordinators = cachedCoordinators() ?? coordinators;
      posts = cachedEventPosts(ctx.coordinate) ?? posts;
      loading = false;
      perfMark("EventSettings", "cache-paint");
      await loadSettings();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      perfMark("EventSettings", "network-settled");
    }
  });

  onDestroy(() => {
    destroyed = true;
    // Leaving with an unsaved preview: restore the published theme.
    if (themePreviewing) void resyncEventTheme(naddr).catch(() => {});
  });

  async function loadSettings() {
    if (!ctx) return;
    posts = await fetchEventPosts(ctx).catch(() => []);
    await loadEventPage();
    await loadTheme();
    // Coordinators list feeds both the attach picker and the replace picker; the
    // lifecycle view additionally loads the attached coordinator's announcement.
    await loadCoordinators();
    if (ctx.config.coordinator) await loadCoordinatorLifecycle();
  }

  // ── Waiting for organizer custody (P2 recovery path) ───────────────────────
  // Mirrors Admin.svelte: the wait's real state is renderable and manually
  // forceable, because the old version could silently not be running at all —
  // see pollForOrganizerGrant in events/organizer.ts for the failure it fixes.
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
      await loadSettings();
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

  async function copyMyNpub() {
    if (!session.npub) return;
    // U15: centralized copy with fallback; npub is public + shown on screen.
    if ((await copyText(session.npub)) === "copied") {
      copiedNpub = true;
      setTimeout(() => (copiedNpub = false), 1500);
    }
  }

  let coordinatorInput = $state("");
  let attaching = $state(false);
  let attached = $state(false);

  // Coordinator lifecycle view (UX-A8): identity + announcement + last-seen +
  // test-connection + re-send grant + replace + detach with consequence text.
  let coordAnnounce = $state<DiscoveredCoordinator | undefined>(undefined);
  let coordLastSeen = $state<number | undefined>(undefined);
  let showReplace = $state(false); // reveals the picker/paste for replacement
  let resending = $state(false);
  let resent = $state(false);
  let detaching = $state(false);
  let confirmingDetach = $state(false);
  let testing = $state(false);
  let testResult = $state<"ok" | "unreachable" | null>(null);

  async function loadCoordinatorLifecycle() {
    if (!ctx?.config.coordinator) return;
    const coordPk = ctx.config.coordinator;
    // Announcement (31611): reuse the discovery fetch and pick this coordinator.
    void fetchCoordinators()
      .then((list) => {
        coordAnnounce = list.find((c) => c.pubkey === coordPk);
      })
      .catch(() => {});
    void fetchCoordinatorLastSeen(ctx)
      .then((s) => (coordLastSeen = s))
      .catch(() => {});
  }

  function sinceLabel(unixSec: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (s < 90) return t("admin.coord.justNow");
    if (s < 3600) return t("admin.coord.minAgo", { n: Math.round(s / 60) });
    if (s < 86400) return t("admin.coord.hAgo", { n: Math.round(s / 3600) });
    return t("admin.coord.dAgo", { n: Math.round(s / 86400) });
  }

  // Test connection (UX-A8): re-fetch the announcement + latest status/last-seen
  // and report whether the coordinator is reachable.
  async function testConnection() {
    if (!ctx?.config.coordinator) return;
    testing = true;
    testResult = null;
    error = null;
    try {
      const list = await fetchCoordinators().catch(() => []);
      coordAnnounce = list.find((c) => c.pubkey === ctx!.config.coordinator) ?? coordAnnounce;
      const seen = await fetchCoordinatorLastSeen(ctx).catch(() => undefined);
      if (seen !== undefined) coordLastSeen = seen;
      // Also try a status read when we hold E_id (a stronger liveness signal).
      if (keys?.eidNsecHex) {
        await fetchCoordinatorStatuses(ctx, keys.eidNsecHex).catch(() => []);
      }
      testResult = coordAnnounce || seen !== undefined ? "ok" : "unreachable";
    } finally {
      testing = false;
    }
  }

  // Re-send the coordinator grant (UX-A8): re-attaching the SAME coordinator
  // re-issues the 21603 grant (bumping the install generation) without rotating.
  async function resendGrant() {
    if (!ctx || !session.signer || !ctx.config.coordinator) return;
    resending = true;
    resent = false;
    error = null;
    try {
      const blindingKey = await deriveBlindingKey(session.signer).catch(() => undefined);
      await attachCoordinator(session.signer, ctx, ctx.config.coordinator, blindingKey);
      resent = true;
      setTimeout(() => (resent = false), 2000);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      resending = false;
    }
  }

  async function detach() {
    if (!ctx || !session.signer || !ctx.config.coordinator) return;
    detaching = true;
    confirmingDetach = false;
    error = null;
    try {
      const blindingKey = await deriveBlindingKey(session.signer).catch(() => undefined);
      await detachCoordinator(session.signer, ctx, blindingKey);
      // Reflect the detach locally so the UI returns to the attach flow.
      ctx = { ...ctx, config: { ...ctx.config, coordinator: undefined } };
      coordAnnounce = undefined;
      coordLastSeen = undefined;
      await loadCoordinators();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      detaching = false;
    }
  }

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

  // Data-retention window (NIP §6.2 `retention`). Empty = no retention tag
  // (indefinite). A positive integer N tells the coordinator to delete member
  // data N days after the event ends. Editing republishes the 31600 config
  // through the same path as talks/chat; the coordinator enforces the sweep.
  // `bind:value` on a number input yields a number (or null when empty), so this
  // is number|null, not a string — null is the "no retention" (indefinite) state.
  let retentionInput = $state<number | null>(null);
  let savingRetention = $state(false);
  let retentionSaved = $state(false);
  $effect(() => {
    if (ctx) retentionInput = ctx.config.retentionDays ?? null;
  });
  const retentionDirty = $derived(!!ctx && (retentionInput ?? undefined) !== ctx.config.retentionDays);
  async function saveRetention() {
    if (!ctx) return;
    // Empty (null) clears the tag (indefinite retention); otherwise require a positive integer.
    let retentionDays: number | undefined;
    if (retentionInput !== null) {
      if (!Number.isInteger(retentionInput) || retentionInput < 1) {
        error = t("admin.retention.invalid");
        return;
      }
      retentionDays = retentionInput;
    }
    savingRetention = true;
    retentionSaved = false;
    error = null;
    try {
      await updateEventConfig(ctx, { retentionDays });
      ctx = { ...ctx, config: { ...ctx.config, retentionDays } };
      retentionSaved = true;
      setTimeout(() => (retentionSaved = false), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      savingRetention = false;
    }
  }

  // Event relays (the 31600 `relay` tags). Admin-only manual edit: existing events
  // are NEVER migrated onto changed app defaults automatically — only a deliberate
  // edit here rewrites a live event's relay list (newly created events pick up the
  // defaults via create.ts). One relay per line; wss:// (ws:// only for loopback).
  let relaysInput = $state("");
  let savingRelays = $state(false);
  let relaysSaved = $state(false);
  $effect(() => {
    if (ctx) relaysInput = ctx.config.relays.join("\n");
  });
  function parseRelaysInput(): string[] {
    return unionRelays(
      relaysInput
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean),
    );
  }
  const relaysDirty = $derived(
    !!ctx && parseRelaysInput().join("\n") !== ctx.config.relays.join("\n"),
  );
  async function saveRelays() {
    if (!ctx) return;
    const relays = parseRelaysInput();
    if (relays.length === 0) {
      error = t("admin.relays.empty");
      return;
    }
    const invalid = relays.find((r) => !isAcceptedRelayUrl(r));
    if (invalid) {
      error = t("admin.relays.invalid", { url: invalid });
      return;
    }
    savingRelays = true;
    relaysSaved = false;
    error = null;
    try {
      await updateEventConfig(ctx, { relays });
      // The saved set is exactly what was typed. Chat-enabled events also carry a
      // separate `chat_relay` set (updateEventConfig keeps the Marmot interop pair
      // in it), which is deliberately NOT mixed back into this box: those relays
      // accept only chat kinds, and showing them here invited an organizer to
      // treat them as event relays — which is how they ended up rejecting every
      // config/roster/deletion publish in the first place.
      const chatRelays = unionRelays(chatRelaysOf(ctx.config), chatInteropRelays(relays));
      ctx = {
        ...ctx,
        config: {
          ...ctx.config,
          relays,
          chatRelays: ctx.config.chat.length > 0 ? chatRelays : chatRelaysOf(ctx.config),
        },
      };
      relaysInput = relays.join("\n");
      relaysSaved = true;
      setTimeout(() => (relaysSaved = false), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      savingRelays = false;
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
      // Blinding key lets attach persist the install generation into the durable
      // 30078 backup too (NIP §3.5), not only the local keystore record.
      const blindingKey = await deriveBlindingKey(session.signer).catch(() => undefined);
      await attachCoordinator(session.signer, ctx, pubkey, blindingKey);
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
      const outcome = await addCoOrganizer(session.signer, ctx, pubkey);
      // R9: the grant wrap is queued to the durable outbox when WSS is blocked or
      // every publish retry fails, and this printed "Sent ✓" either way — so one
      // organizer saw the hand-off succeed while the other device sat on the
      // grant-wait card forever, with the wrap still on this phone. Same
      // queued-vs-published split the metadata save above uses.
      if (outcome === "queued") {
        opStatus.queued(t("op.coOrgQueued"));
      } else {
        opStatus.published(t("op.coOrgSent"));
        coOrgAdded = true;
      }
      coOrgInput = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      addingCoOrg = false;
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

  // External long-form feeds folded into the official posts (31608 `sources`).
  let pageSources = $state<ExternalFeed[]>([]);
  let feedNpub = $state("");
  let feedTags = $state(""); // comma-separated hashtags
  let feedSince = $state(""); // yyyy-mm-dd from a date input
  let feedRelays = $state(""); // comma/space separated wss:// URLs
  let feedLabel = $state("");
  let feedError = $state<string | null>(null);

  async function loadEventPage() {
    if (!ctx) return;
    const page = await fetchEventPage(ctx).catch(() => undefined);
    pageMenu = page?.menu ?? [];
    pageSections = page?.sections ?? [];
    pageSources = page?.sources ?? [];
    pageLoaded = true;
  }

  /** Split a comma/whitespace separated field into trimmed, non-empty items. */
  function splitList(raw: string): string[] {
    return raw
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  function addFeedSource() {
    feedError = null;
    const entry = feedNpub.trim();
    if (!entry) return;
    // Accept an npub (what an organizer actually has) or raw hex.
    let pubkey: string;
    try {
      if (/^[0-9a-f]{64}$/i.test(entry)) {
        pubkey = entry.toLowerCase();
      } else {
        const decoded = decode(entry);
        if (decoded.type !== "npub") throw new Error("not an npub");
        pubkey = decoded.data;
      }
    } catch {
      feedError = t("admin.page.feeds.badNpub");
      return;
    }
    if (pageSources.some((f) => f.pubkey === pubkey)) {
      feedError = t("admin.page.feeds.duplicate");
      return;
    }
    if (pageSources.length >= MAX_FEED_SOURCES) {
      feedError = t("admin.page.feeds.tooMany", { n: MAX_FEED_SOURCES });
      return;
    }
    // A date input gives local midnight; the field means "articles published on
    // or after this day", so local midnight is the right instant to compare
    // published_at against.
    const sinceMs = feedSince ? new Date(`${feedSince}T00:00:00`).getTime() : NaN;
    const tags = splitList(feedTags).map((h) => h.replace(/^#/, ""));
    const relays = splitList(feedRelays);
    pageSources = [
      ...pageSources,
      {
        pubkey,
        ...(tags.length ? { tags: tags.slice(0, MAX_FEED_TAGS) } : {}),
        ...(Number.isFinite(sinceMs) ? { since: Math.floor(sinceMs / 1000) } : {}),
        ...(relays.length ? { relays } : {}),
        ...(feedLabel.trim() ? { label: feedLabel.trim() } : {}),
      },
    ];
    feedNpub = "";
    feedTags = "";
    feedSince = "";
    feedRelays = "";
    feedLabel = "";
  }

  /** Short, recognisable rendering of a declared feed for the list. */
  function feedSummary(f: ExternalFeed): string {
    const parts: string[] = [f.label?.trim() || npubEncode(f.pubkey).slice(0, 16) + "…"];
    if (f.tags?.length) parts.push(f.tags.map((h) => `#${h}`).join(" "));
    if (f.since !== undefined) {
      parts.push(
        t("admin.page.feeds.sinceLabel", {
          date: new Date(f.since * 1000).toLocaleDateString(),
        }),
      );
    }
    return parts.join(" · ");
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
      const outcome = await publishEventPage(ctx, {
        menu: pageMenu,
        sections: pageSections,
        sources: pageSources,
      });
      // R9: only claim "saved ✓" / published on a real relay publish; a queued
      // save is honest about attendees still seeing the old page.
      if (outcome === "queued") {
        opStatus.queued(t("op.pageQueued"));
      } else {
        opStatus.published(t("op.pagePublished"));
        pageSaved = true;
        setTimeout(() => (pageSaved = false), 2000);
      }
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
  // Durable draft of UNSENT theme CSS (audit U9). The network only carries the
  // PUBLISHED theme, so hand-written CSS an organizer hasn't published yet would
  // be lost to a crash/eviction/reload. Persist owner-scoped; restore visibly.
  let themeDraftId = $state("");
  let themeDraftRestored = $state(false);
  let themeLoaded = $state(false);
  let publishedTheme = $state("");

  // Draft-safe auto-refresh (App-2): hold the pending reload while the organizer
  // has unsaved metadata edits (title/summary differ from the loaded event) or a
  // half-filled add-coordinator / add-co-organizer input; it applies once saved
  // or cleared. Theme CSS is loaded from the network so it's excluded (a reload
  // just refetches it).
  $effect(() => {
    const dirty =
      (!!ctx && (metadataTitle !== ctx.title || metadataSummary !== ctx.summary)) ||
      coordinatorInput.trim().length > 0 ||
      coOrgInput.trim().length > 0 ||
      // Unsaved theme CSS is real unsaved work now that it's drafted (U9).
      (themeLoaded && themeCss !== publishedTheme);
    if (dirty) return refreshGuard.hold("settings");
  });

  // Persist unsent theme CSS as it's edited (U9); clear it once it matches the
  // published theme so a later visit doesn't restore already-published CSS.
  $effect(() => {
    if (!themeLoaded || !themeDraftId) return;
    if (themeCss === publishedTheme) clearDraft(themeDraftId);
    else saveDraft(themeDraftId, themeCss);
  });

  async function loadTheme() {
    if (!ctx) return;
    themeCss = (await fetchEventTheme(ctx).catch(() => undefined)) ?? "";
    // U9: restore an unsent draft that differs from the published theme.
    themeDraftId = `theme:${ctx.coordinate}`;
    publishedTheme = themeCss;
    const draft = loadDraft(themeDraftId);
    if (draft !== undefined && draft !== publishedTheme) {
      themeCss = draft;
      themeDraftRestored = true;
    }
    themeLoaded = true;
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
      const outcome = await publishEventTheme(ctx, themeCss);
      previewEventTheme(naddr, themeCss); // published = what you see (locally)
      themePreviewing = false;
      if (outcome === "queued") {
        // R9 + U9: a WSS-blocked save only queued the theme — it is NOT live for
        // attendees, so KEEP the durable draft (clearing it here would lose the
        // unsent CSS if the queued publish never lands) and say so honestly.
        opStatus.queued(t("op.themeQueued"));
      } else {
        themePublished = true;
        // U9: really published — retire the unsent draft.
        publishedTheme = themeCss;
        if (themeDraftId) clearDraft(themeDraftId);
        themeDraftRestored = false;
        opStatus.published(t("op.themePublished"));
        setTimeout(() => (themePublished = false), 2000);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      themeBusy = false;
    }
  }
</script>

<div class="row" style="justify-content:space-between;align-items:center">
  <h1 style="margin:0">{t("admin.settings.title")}</h1>
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
  <p class="muted">{t("admin.settings.loading")}</p>
{:else}
  {#if missingEidKey}
    <div class="card warn" style="margin-bottom:0.75rem">
      <strong>{t("admin.noEidKey.title")}</strong>
      <p class="muted" style="margin:0.25rem 0 0">{t("admin.noEidKey.body")}</p>
    </div>
  {/if}

  <div class="card stack">
    <div>
      <div class="field-label">{t("admin.metadata.title")}</div>
      <p class="muted" style="margin:0.25rem 0 0">{t("admin.metadata.body")}</p>
    </div>
    <div>
      <label for="metadata-title">{t("create.field.title")}</label>
      <input id="metadata-title" bind:value={metadataTitle} />
    </div>
    <div>
      <label for="metadata-summary">{t("create.field.summary")}</label>
      <textarea id="metadata-summary" rows="3" bind:value={metadataSummary}></textarea>
    </div>
    <div class="row" style="gap:0.75rem;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <label for="metadata-start">{t("create.field.start")}</label>
        <input id="metadata-start" type="datetime-local" class="datetime-input" bind:value={metadataStart} />
      </div>
      <div style="flex:1;min-width:180px">
        <label for="metadata-end">{t("create.field.end")}</label>
        <input
          id="metadata-end"
          type="datetime-local"
          class="datetime-input"
          bind:value={metadataEnd}
          min={metadataStart}
          aria-invalid={metadataEndBeforeStart}
        />
        {#if metadataEndBeforeStart}
          <p class="muted" style="margin:0.25rem 0 0;color:var(--danger)">
            {t("create.error.endBeforeStart")}
          </p>
        {/if}
      </div>
    </div>
    <div>
      <label for="metadata-location">{t("create.field.location")}</label>
      <input id="metadata-location" bind:value={metadataLocation} />
    </div>
    <div>
      <div class="field-label">
        {t("create.field.images")}
        <span class="muted" style="font-weight:400">{t("create.field.images.optional")}</span>
      </div>
      <div class="row" style="align-items:flex-start;gap:0.75rem">
        <div style="flex:none;text-align:center">
          <img
            src={metadataPreviewIcon}
            alt={t("create.iconAlt")}
            style="width:64px;height:64px;border-radius:14px;object-fit:cover"
          />
          <div style="margin-top:0.35rem">
            <FileButton
              class="btn inline"
              style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem"
              accept="image/*"
              onchange={(e) => pickMetadataImage(e, "icon")}
              label={t("create.iconPick")}
            >
              {metadataUploading === "icon" ? "…" : t("create.icon")}
            </FileButton>
          </div>
        </div>
        <div style="flex:1">
          <img
            src={metadataPreviewBanner}
            alt={t("create.bannerAlt")}
            style="width:100%;border-radius:12px;aspect-ratio:5/2;object-fit:cover"
          />
          <div class="row" style="margin-top:0.35rem">
            <FileButton
              class="btn inline"
              style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem"
              accept="image/*"
              onchange={(e) => pickMetadataImage(e, "banner")}
              label={t("create.bannerPick")}
            >
              {metadataUploading === "banner" ? "…" : t("create.banner")}
            </FileButton>
            {#if metadataIcon || metadataBanner}
              <button
                class="btn inline"
                style="font-size:0.8rem;padding:0.3rem 0.6rem"
                onclick={() => {
                  metadataIcon = "";
                  metadataBanner = "";
                }}
              >{t("create.reset")}</button>
            {/if}
          </div>
        </div>
      </div>
      <p class="muted">{t("create.images.body")}</p>
    </div>
    <div class="row">
      <button
        class="btn inline primary"
        onclick={saveMetadata}
        disabled={metadataBusy || metadataUploading !== null || !metadataTitle.trim() || !metadataStart || metadataEndBeforeStart}
      >
        {metadataBusy ? t("admin.metadata.saving") : t("admin.metadata.save")}
      </button>
      {#if metadataSaved}<span class="muted">{t("admin.metadata.saved")}</span>{/if}
    </div>
  </div>

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
                  {#each section.refs as ref, r (r)}
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

    <!-- External long-form feeds (31608 `sources`): other npubs' 30023 folded
         into this event's official posts. -->
    <div class="field-label" style="margin-top:1rem">{t("admin.page.feeds")}</div>
    <p class="muted" style="margin:0 0 0.5rem">{t("admin.page.feeds.body")}</p>
    {#if pageSources.length}
      <div class="stack" style="margin-bottom:0.5rem">
        {#each pageSources as feed, i (feed.pubkey)}
          <div class="card" style="background:var(--bg-elev2)">
            <div class="row" style="justify-content:space-between;align-items:center">
              <span style="overflow:hidden;text-overflow:ellipsis">{feedSummary(feed)}</span>
              <button
                class="btn inline danger"
                style="flex:none"
                aria-label={t("admin.page.feeds.remove")}
                onclick={() => (pageSources = pageSources.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            <p class="mono muted" style="margin:0.25rem 0 0;font-size:0.7rem;overflow-wrap:anywhere">
              {npubEncode(feed.pubkey)}
            </p>
            {#if feed.relays?.length}
              <p class="mono muted" style="margin:0.15rem 0 0;font-size:0.7rem;overflow-wrap:anywhere">
                {feed.relays.join(" ")}
              </p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <input
      placeholder={t("admin.page.feeds.npubPlaceholder")}
      bind:value={feedNpub}
      aria-label={t("admin.page.feeds.npubPlaceholder")}
    />
    <input
      placeholder={t("admin.page.feeds.tagsPlaceholder")}
      bind:value={feedTags}
      aria-label={t("admin.page.feeds.tagsPlaceholder")}
      style="margin-top:0.5rem"
    />
    <label class="stack" style="gap:0.25rem;margin-top:0.5rem">
      <span class="muted">{t("admin.page.feeds.since")}</span>
      <input type="date" bind:value={feedSince} />
    </label>
    <input
      placeholder={t("admin.page.feeds.relaysPlaceholder")}
      bind:value={feedRelays}
      aria-label={t("admin.page.feeds.relaysPlaceholder")}
      style="margin-top:0.5rem"
    />
    <p class="muted" style="margin:0.25rem 0 0;font-size:0.8rem">
      {t("admin.page.feeds.relaysHint")}
    </p>
    <input
      placeholder={t("admin.page.feeds.labelPlaceholder")}
      bind:value={feedLabel}
      aria-label={t("admin.page.feeds.labelPlaceholder")}
      style="margin-top:0.5rem"
    />
    {#if feedError}
      <p class="field-error" role="alert" style="margin:0.5rem 0 0">{feedError}</p>
    {/if}
    <button
      class="btn inline"
      style="margin-top:0.5rem"
      onclick={addFeedSource}
      disabled={!feedNpub.trim()}
    >
      {t("admin.page.feeds.add")}
    </button>

    <div class="row" style="margin-top:0.75rem">
      <button class="btn inline primary" onclick={savePage} disabled={pageBusy || !pageLoaded}>
        {pageBusy ? t("admin.page.saving") : t("admin.page.save")}
      </button>
      {#if pageSaved}<span class="muted">{t("admin.page.saved")}</span>{/if}
    </div>
  </div>

  {#if metadataCropFile}
    <ImageCropper
      file={metadataCropFile}
      aspect={metadataCropWhich === "icon" ? 1 : 2.5}
      outWidth={metadataCropWhich === "icon" ? 512 : 1500}
      onConfirm={uploadMetadataImage}
      onCancel={() => (metadataCropFile = null)}
    />
  {/if}

  <div class="card">
    <div class="field-label">{t("admin.theme.title")}</div>
    <p class="muted">{t("admin.theme.body")}</p>
    {#if themeDraftRestored}
      <!-- Visible restore of unsent theme CSS (U9). -->
      <div class="row" style="justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <span class="muted" role="status">{t("draft.restored")}</span>
        <button
          class="btn inline"
          style="flex:none"
          onclick={() => {
            themeCss = publishedTheme;
            themeDraftRestored = false;
            if (themeDraftId) clearDraft(themeDraftId);
          }}>{t("draft.discard")}</button>
      </div>
    {/if}
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

    {#snippet pickerBody(replace: boolean)}
      {#if loadingCoordinators}
        <p class="muted">{t("admin.coordinator.discovering")}</p>
      {:else if coordinators.filter((c) => c.pubkey !== ctx?.config.coordinator).length}
        <div class="stack" style="gap:0.5rem;margin:0.5rem 0">
          {#each coordinators.filter((c) => c.pubkey !== ctx?.config.coordinator) as c (c.pubkey)}
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
                {#if httpsUrl(c.announce.terms_url)}
                  <a class="btn inline" href={httpsUrl(c.announce.terms_url)} target="_blank" rel="noopener noreferrer">{t("admin.coordinator.terms")}</a>
                {/if}
                <button class="btn inline primary" onclick={() => attachPubkey(c.pubkey)} disabled={attaching}>
                  {attaching
                    ? t("admin.coordinator.attaching")
                    : replace ? t("admin.coordinator.replaceThis") : t("admin.coordinator.attachThis")}
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
          {attaching ? t("admin.coordinator.attaching") : replace ? t("admin.coordinator.replace") : t("admin.coordinator.attach")}
        </button>
      </details>
    {/snippet}

    {#if ctx?.config.coordinator}
      <!-- Lifecycle view (UX-A8): identity, announcement, last-seen, and the full
           set of controls once attached. -->
      <p class="muted">{t("admin.coordinator.identity")}
        <span class="mono">{ctx.config.coordinator.slice(0, 16)}…</span></p>
      {#if coordAnnounce}
        <div class="row" style="gap:0.6rem;align-items:center;margin:0.35rem 0">
          {#if coordAnnounce.announce.picture}<img src={coordAnnounce.announce.picture} alt="" class="coord-logo" />{/if}
          <div>
            <strong>{coordAnnounce.announce.name}</strong>
            <span class="badge">{pricingLabel(coordAnnounce.announce)}</span>
          </div>
        </div>
        <div class="row" style="flex-wrap:wrap;gap:0.3rem">
          {#if coordAnnounce.announce.features?.matching}<span class="badge">{t("admin.coordinator.feat.matching")}</span>{/if}
          {#if coordAnnounce.announce.features?.talks}<span class="badge">{t("admin.coordinator.feat.talks")}</span>{/if}
          {#if coordAnnounce.announce.features?.chat?.length}<span class="badge">{t("admin.coordinator.feat.chat")}</span>{/if}
          {#if coordAnnounce.announce.privacy}
            {#each Object.entries(coordAnnounce.announce.privacy).filter(([, v]) => v !== "private") as [role] (role)}
              <span class="badge warn">{role}: {t("admin.coordinator.nonPrivate")}</span>
            {/each}
          {/if}
        </div>
      {/if}
      <p class="muted" style="margin:0.35rem 0">
        {t("admin.coordinator.lastSeen")}
        {#if coordLastSeen === undefined}
          <span class="badge warn">{t("admin.checkingStatus")}</span>
        {:else}
          <span class="badge {Math.floor(Date.now() / 1000) - coordLastSeen > 3600 ? 'warn' : 'ok'}">{sinceLabel(coordLastSeen)}</span>
        {/if}
      </p>

      <div class="row" style="flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem">
        <button class="btn inline" onclick={testConnection} disabled={testing}>
          {testing ? t("admin.coordinator.testing") : t("admin.coordinator.test")}
        </button>
        <button class="btn inline" onclick={resendGrant} disabled={resending}>
          {resending ? t("admin.coordinator.resending") : t("admin.coordinator.resend")}
        </button>
        <button class="btn inline" onclick={() => (showReplace = !showReplace)}>{t("admin.coordinator.replace")}</button>
      </div>
      {#if testResult === "ok"}<p class="muted" role="status" style="margin:0.35rem 0 0">{t("admin.coordinator.testOk")}</p>{/if}
      {#if testResult === "unreachable"}<p class="muted" style="color:var(--danger);margin:0.35rem 0 0">{t("admin.coordinator.testFail")}</p>{/if}
      {#if resent}<p class="muted" role="status" style="margin:0.35rem 0 0">{t("admin.coordinator.resent")}</p>{/if}

      {#if showReplace}
        <div class="card" style="background:var(--bg-elev2);margin-top:0.5rem">
          <p class="muted" style="margin:0 0 0.25rem">{t("admin.coordinator.replace.body")}</p>
          {@render pickerBody(true)}
        </div>
      {/if}

      <!-- Detach with explicit consequences (keys rotate, chat admin orphaned). -->
      <div class="card" style="border-left:3px solid var(--danger);margin-top:0.75rem">
        {#if confirmingDetach}
          <p class="muted" style="margin:0 0 0.5rem">{t("admin.coordinator.detach.consequence")}</p>
          <div class="row">
            <button class="btn inline danger" onclick={detach} disabled={detaching}>
              {detaching ? t("admin.coordinator.detaching") : t("admin.coordinator.detach.confirm")}
            </button>
            <button class="btn inline" onclick={() => (confirmingDetach = false)}>{t("admin.revoke.keep")}</button>
          </div>
        {:else}
          <button class="btn inline danger" onclick={() => (confirmingDetach = true)}>{t("admin.coordinator.detach")}</button>
        {/if}
      </div>
    {:else if attached}
      <p class="muted">{t("admin.coordinator.attachedOk")}</p>
    {:else}
      <p class="muted">{t("admin.coordinator.body")}</p>
      {@render pickerBody(false)}
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
        {savingTalks ? t("admin.saving") : t("admin.talks.save")}
      </button>
      {#if talksSaved}<span class="muted">{t("admin.saved")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.retention.title")}</div>
    <p class="muted">{t("admin.retention.body")}</p>
    <div class="row" style="align-items:center;gap:0.5rem">
      <input
        type="number"
        min="1"
        step="1"
        inputmode="numeric"
        style="max-width:6rem"
        placeholder={t("admin.retention.placeholder")}
        aria-label={t("admin.retention.title")}
        bind:value={retentionInput}
      />
      <span class="muted">{t("admin.retention.unit")}</span>
    </div>
    <p class="muted" style="margin:0.4rem 0 0;font-size:0.8rem">
      {retentionInput === null || retentionInput === undefined
        ? t("admin.retention.consequenceOff")
        : t("admin.retention.consequence", { n: String(retentionInput) })}
    </p>
    <div class="row" style="margin-top:0.5rem">
      <button class="btn inline" onclick={saveRetention} disabled={savingRetention || !retentionDirty}>
        {savingRetention ? t("admin.saving") : t("admin.retention.save")}
      </button>
      {#if retentionSaved}<span class="muted">{t("admin.saved")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.relays.title")}</div>
    <p class="muted">{t("admin.relays.body")}</p>
    <textarea
      rows="5"
      spellcheck="false"
      autocapitalize="off"
      style="width:100%;font-family:monospace;font-size:0.85rem"
      placeholder={t("admin.relays.placeholder")}
      aria-label={t("admin.relays.title")}
      bind:value={relaysInput}
    ></textarea>
    <p class="muted" style="margin:0.4rem 0 0;font-size:0.8rem">{t("admin.relays.hint")}</p>
    <!-- Group chat rides on its own relay set, kept out of the box above because
         those relays accept chat kinds only. Surfaced read-only so an organizer
         who sees the event's chat reaching Whitenoise users isn't left wondering
         which relays that happens over. -->
    {#if ctx && chatRelaysOf(ctx.config).length > 0}
      <p class="muted" style="margin:0.4rem 0 0;font-size:0.8rem">
        {t("admin.relays.chat", { relays: chatRelaysOf(ctx.config).join(", ") })}
      </p>
    {/if}
    <div class="row" style="margin-top:0.5rem">
      <button class="btn inline" onclick={saveRelays} disabled={savingRelays || !relaysDirty}>
        {savingRelays ? t("admin.saving") : t("admin.relays.save")}
      </button>
      {#if relaysSaved}<span class="muted">{t("admin.saved")}</span>{/if}
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
        {savingChat ? t("admin.saving") : t("chat.toggle.save")}
      </button>
      {#if chatSaved}<span class="muted">{t("admin.saved")}</span>{/if}
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
