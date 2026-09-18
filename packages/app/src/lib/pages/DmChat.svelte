<script lang="ts">
  // One NIP-17 conversation (spec §7.2 kind 14). Polls while open; optimistic
  // append on send so the chat feels instant even before relays echo the wrap.
  import { onMount, onDestroy, tick } from "svelte";
  import { decode, npubEncode } from "nostr-tools/nip19";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { coordinateToNaddr } from "@nostrautica/protocol";
  import { fetchDms, cachedDms, sendDm, mergeOptimisticDms, type DmMessage } from "$lib/events/dm.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchFollowSet, cachedFollowSet } from "$lib/events/social.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import {
    loadPerEventSettings,
    toggleSetting,
    cachedPerEventSettings,
  } from "$lib/events/settings.js";
  import type { PerEventSettings } from "@nostrautica/protocol";
  import FollowButton from "$lib/components/FollowButton.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { listEventKeys } from "$lib/events/keystore.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import { fillHeight } from "$lib/components/fill-height.js";
  import { autoGrow } from "$lib/components/auto-grow.js";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import { dmPrefill } from "$lib/stores/dm-prefill.svelte.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { saveDraft, loadDraft } from "$lib/stores/drafts.js";
  import { dmUnread } from "$lib/stores/dm-unread.svelte.js";
  import { syncDmReadState, flushDmReadState } from "$lib/events/dm-read-state.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";

  let { npub }: { npub: string } = $props();

  const peer = $derived.by(() => {
    try {
      const d = decode(npub);
      return d.type === "npub" ? (d.data as string) : null;
    } catch {
      return null;
    }
  });

  let messages = $state<DmMessage[]>([]);
  let profile = $state<ProfileMeta | undefined>(undefined);
  let draft = $state("");
  let loading = $state(true);
  let sending = $state(false);
  let error = $state<unknown>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let scroller = $state<HTMLDivElement | null>(null);
  /** The composer row — reserved space under the transcript (see `fillHeight`). */
  let composerEl = $state<HTMLElement | null>(null);
  let muteBusy = $state(false);
  const muted = $derived(!!peer && mutes.isMuted(peer));

  async function markVisibleRead(): Promise<void> {
    if (!peer || typeof document === "undefined" || document.visibilityState !== "visible") return;
    await tick();
    dmUnread.markThreadRead(peer, messages);
    dmUnread.acknowledgeEncryptedActivity();
  }

  $effect(() => {
    void cacheHydration.version;
    if (!peer || !session.pubkey || messages.length > 0) return;
    const cached = cachedDms(session.pubkey).filter((m) => m.peer === peer);
    if (!cached.length) return;
    messages = cached;
    dmUnread.syncMessages(session.pubkey, cachedDms(session.pubkey));
    loading = false;
    void markVisibleRead();
  });

  // Draft-safe auto-refresh (App-2): persist the compose text (owner-scoped) so a
  // deploy that reloads the tab doesn't lose it, and hold off that reload while
  // the box has unsent text — it applies automatically once the box is empty.
  const draftId = $derived(`dm:${npub}`);
  $effect(() => {
    const id = draftId;
    const text = draft;
    saveDraft(id, text);
    if (text.trim().length > 0) return refreshGuard.hold("dm");
  });
  // "Also attending: …" (user feedback 2026-07-20) — every event the CURRENT
  // user holds a working key for (listEventKeys: local, network-free, and the
  // authoritative "can I actually decrypt this event's data" answer — unlike
  // recentEvents' role field, which is set at join-REQUEST time and stays
  // "attendee" even for a request that was never approved) that also lists
  // the peer on its roster. Deliberately fetchRoster, not fetchDirectory: a
  // roster entry is a plain {pubkey, role}, so this needs no per-attendee
  // profile/media/AI-profile decrypt, just a membership check. Cache-first
  // per event (instant paint when the roster's already warm from visiting
  // People there), but always falls through to a real fetch on a cache miss
  // or a "not found" — the whole point is not to under-report from a merely
  // cold cache, which is why this was deferred rather than shipped earlier.
  // start/end are present-but-possibly-undefined rather than optional: 31923
  // makes dates optional, and the loader always sets both keys.
  type SharedEvent = { title: string; naddr: string; start: number | undefined; end: number | undefined };
  let sharedEvents = $state<SharedEvent[]>([]);

  async function loadSharedEvents(peerPubkey: string): Promise<void> {
    try {
      const keys = await listEventKeys();
      const withEck = keys.filter((k) => k.eck.length > 0);
      const found = await Promise.all(
        withEck.map(async (k) => {
          try {
            const naddr = coordinateToNaddr(k.coordinate);
            const cachedR = cachedRoster(k.coordinate);
            if (cachedR?.attendees.some((a) => a.pubkey === peerPubkey)) {
              const c =
                cachedEventContext(naddr) ?? (await loadEventContext(naddr, { adoptLang: false }));
              return { title: c.title, naddr, start: c.start, end: c.end };
            }
            const ctx = cachedEventContext(naddr) ?? (await loadEventContext(naddr, { adoptLang: false }));
            const roster = await fetchRoster(ctx);
            return roster?.attendees.some((a) => a.pubkey === peerPubkey)
              ? { title: ctx.title, naddr, start: ctx.start, end: ctx.end }
              : undefined;
          } catch {
            return undefined; // one bad event must not blank the whole list
          }
        }),
      );
      sharedEvents = found.filter((e): e is SharedEvent => !!e);
      // Want-to-meet / Open profile hang off the chosen shared event, so their
      // state can only load once that list exists.
      const primary = primaryEvent;
      if (primary) void loadEventActions(primary.naddr);
    } catch {
      sharedEvents = [];
    }
  }

  // --- Header peer actions (user request 2026-09-10) --------------------------
  // Follow is account-global, so it is always offered. Want-to-meet and Open
  // profile are per-EVENT — the setting is stored per event and an attendee
  // profile only exists inside one — so they act on the first shared event and
  // NAME it in their tooltips. Picking one of several silently is the thing to
  // avoid: the user would have no way to tell which event they just marked.
  let followSet = $state<Set<string>>(cachedFollowSet() ?? new Set());
  let followsKnown = $state(cachedFollowSet() !== undefined);
  let blindingKey: Uint8Array | null = null;
  let actionCtx = $state<EventContext | null>(null);
  let settings = $state<PerEventSettings | null>(null);
  let meetBusy = $state(false);

  /**
   * Which shared event the per-event actions act on.
   *
   * NOT simply the first (user feedback 2026-09-10): two people can share an
   * event that finished months ago, and "want to meet at" a conference that is
   * over is meaningless — it writes a private note nobody will ever act on, on
   * the event least likely to be the one you are talking about.
   *
   * So: the soonest event that has not ended yet, an event with no dates counted
   * as live (a date is optional in 31923, and excluding undated events would
   * hide the action entirely for them). Only when every shared event is over
   * does it fall back to the most RECENT past one — still the likeliest subject
   * of the conversation, and better than the oldest.
   */
  const primaryEvent = $derived.by(() => {
    const now = Math.floor(Date.now() / 1000);
    const ended = (e: SharedEvent) => (e.end ?? e.start) !== undefined && (e.end ?? e.start)! < now;
    const live = sharedEvents.filter((e) => !ended(e));
    if (live.length) {
      return [...live].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0];
    }
    return [...sharedEvents].sort((a, b) => (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0))[0];
  });
  const following = $derived(!!peer && followSet.has(peer));
  const wantsToMeet = $derived(!!peer && !!settings?.want_to_meet?.includes(peer));

  /** FollowButton published a change — keep this page's set authoritative. */
  function noteFollow(f: boolean) {
    if (!peer) return;
    const next = new Set(followSet);
    if (f) next.add(peer);
    else next.delete(peer);
    followSet = next;
  }

  /** Per-event state behind the Want-to-meet toggle (cache-first, like People). */
  async function loadEventActions(naddr: string): Promise<void> {
    if (!session.signer) return;
    const signer = session.signer;
    try {
      const ctx =
        cachedEventContext(naddr) ?? (await loadEventContext(naddr, { adoptLang: false }));
      actionCtx = ctx;
      settings = cachedPerEventSettings(ctx.coordinate) ?? settings;
      blindingKey ??= await deriveBlindingKey(signer);
      settings = await loadPerEventSettings(signer, ctx, blindingKey);
    } catch {
      // No settings event yet is the normal first-time case, not an error — the
      // toggle simply starts unpressed. Leaving `error` alone matters: this is
      // background state for one button and must not blank the conversation.
    }
  }

  async function toggleWantToMeet(): Promise<void> {
    if (!session.signer || !peer || !actionCtx || !blindingKey) return;
    meetBusy = true;
    try {
      settings = await toggleSetting(session.signer, actionCtx, blindingKey, "want_to_meet", peer);
    } catch (e) {
      error = e;
    } finally {
      meetBusy = false;
    }
  }

  function openProfile(): void {
    if (!primaryEvent || !peer) return;
    router.go({ name: "attendee", naddr: primaryEvent.naddr, npub: npubEncode(peer) });
  }

  async function toggleMute() {
    if (!session.signer || !peer) return;
    muteBusy = true;
    try {
      await mutes.toggle(session.signer, peer);
    } catch (e) {
      error = e;
    } finally {
      muteBusy = false;
    }
  }

  async function refresh() {
    if (!session.signer || !peer) return;
    try {
      const all = await fetchDms(session.signer);
      const mine = all.filter((m) => m.peer === peer);
      const atBottom =
        !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      // Merge (audit UX-3): keep optimistic local echoes until the memo holds a
      // matching copy — otherwise a just-sent DM vanishes on the next 5s poll
      // until its self-wrap round-trips (and a queued offline send would never
      // show at all).
      messages = mergeOptimisticDms(mine, messages);
      if (session.pubkey) dmUnread.syncMessages(session.pubkey, all);
      error = null;
      if (atBottom) {
        await tick();
        scroller?.scrollTo({ top: scroller.scrollHeight });
      }
      await markVisibleRead();
      // Reconcile this thread's read position with the account's other devices.
      // Safe here (unlike in the app shell) because this screen already drives
      // the signer on every poll — see lib/events/dm-read-state.ts.
      if (session.signer) void syncDmReadState(session.signer);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("DmChat", "network-settled");
    }
  }

  onMount(async () => {
    // "Introduce us" prefill (§9.3): consume a one-shot suggested opening line the
    // Matches screen staged for this peer. Prefill only — the user edits before send.
    if (peer) {
      const staged = dmPrefill.take(peer);
      if (staged && !draft) draft = staged;
    }
    // Restore a compose draft left by a previous session/refresh (App-2), unless
    // a prefill already populated the box. Owner-scoped, so nothing cross-leaks.
    if (!draft && session.pubkey) {
      const saved = loadDraft(`dm:${npub}`);
      if (saved) draft = saved;
    }
    // Cache-first: paint the name/avatar the People list already fetched, so the
    // header isn't a bare npub while the network/signer is slow (user feedback
    // 2026-07-17). Refresh in the background.
    if (peer) profile = cachedProfiles([peer]).get(peer) ?? profile;
    // Cache-first thread (§2.6): paint prior messages from the persisted DM memo
    // before connectNdk()/the signer resolve, so the conversation isn't blank.
    if (peer && session.pubkey) {
      const cached = cachedDms(session.pubkey).filter((m) => m.peer === peer);
      if (cached.length) {
        messages = cached;
        dmUnread.syncMessages(session.pubkey, cachedDms(session.pubkey));
        loading = false;
        perfMark("DmChat", "cache-paint");
        void markVisibleRead();
      }
    }
    await connectNdk();
    if (session.signer) void mutes.load(session.signer);
    if (peer) {
      void fetchProfiles([peer])
        .then((m) => {
          const p = m.get(peer);
          if (p) profile = p;
        })
        .catch(() => {});
      void loadSharedEvents(peer);
    }
    if (session.signer) {
      void fetchFollowSet(session.signer)
        .then((set) => {
          followSet = set;
          followsKnown = true;
        })
        .catch(() => {});
    }
    await refresh();
    timer = setInterval(refresh, 5_000);
    document.addEventListener("visibilitychange", markVisibleRead);
  });
  onDestroy(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", markVisibleRead);
    // Reading the last message and immediately navigating away is the common
    // case; without this the debounced publish would be torn down before it
    // fired and the read would never leave this device.
    flushDmReadState();
  });

  let sendSlow = $state(false);
  async function send() {
    const text = draft.trim();
    if (!text || !session.signer || !peer || sending) return;
    sending = true;
    sendSlow = false;
    error = null;
    // If the signer (esp. a remote Amber/bunker) is slow to sign+encrypt, say so
    // rather than showing a silent spinner (user feedback 2026-07-17).
    const slowTimer = setTimeout(() => (sendSlow = true), 6_000);
    try {
      const published = await sendDm(session.signer, peer, text);
      const me = await session.signer.getPublicKey();
      // Offline / all publish retries failed → the wrap sits in the durable
      // queue; mark it honestly (audit UX-4) instead of implying delivery.
      if (!published) outbox.noteQueued();
      messages = [
        ...messages,
        {
          id: `local-${Date.now()}`,
          peer,
          from: me,
          text,
          at: Math.floor(Date.now() / 1000),
          ...(published ? {} : { queued: true }),
        },
      ];
      draft = "";
      await tick();
      scroller?.scrollTo({ top: scroller.scrollHeight });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(slowTimer);
      sendSlow = false;
      sending = false;
    }
  }

  const title = $derived(profile?.name || (peer ? npubEncode(peer).slice(0, 12) + "…" : t("dmchat.title")));
  function fmt(at: number): string {
    return new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

{#if !session.loggedIn}
  <div class="card">
    <p>{t("dmchat.loginToSend")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("dmchat.login")}</button>
  </div>
{:else if !peer}
  <div class="card warn">{t("dmchat.invalidLink")}</div>
{:else}
  <div class="row hdr">
    <Avatar pubkey={peer} name={profile?.name} picture={profile?.picture} size={40} />
    <h1 style="margin:0;font-size:1.25rem;flex:1;min-width:0">{title}</h1>
    <!-- The same quick actions a People row offers, so the two screens agree
         (user request 2026-09-10). Icon-only here: the header already carries an
         avatar and a name, and four labelled buttons do not fit a phone. The
         accessible name and the tooltip always spell the action out, and they
         name the event for the two that are per-event. -->
    <div class="acts">
      {#if peer !== session.pubkey}
        {#if primaryEvent}
          <button
            class="btn inline icon-btn"
            aria-pressed={wantsToMeet}
            class:primary={wantsToMeet}
            disabled={meetBusy || !actionCtx}
            title={t("dmchat.wantToMeetAt", { event: primaryEvent.title })}
            aria-label={t("dmchat.wantToMeetAt", { event: primaryEvent.title })}
            onclick={() => void toggleWantToMeet()}
          >
            <Icon name="bookmark" size={16} />
          </button>
          <button
            class="btn inline icon-btn"
            title={t("dmchat.openProfileAt", { event: primaryEvent.title })}
            aria-label={t("dmchat.openProfileAt", { event: primaryEvent.title })}
            onclick={openProfile}
          >
            <Icon name="person" size={16} />
          </button>
        {/if}
        {#if followsKnown}
          <FollowButton pubkey={peer} name={title} {following} onChange={(f) => noteFollow(f)} />
        {/if}
      {/if}
      <button class="btn inline" style="flex:none" onclick={toggleMute} disabled={muteBusy}>
        {muted ? t("attendee.unmute") : t("attendee.mute")}
      </button>
    </div>
  </div>
  <p class="muted" style="margin:0 0 0.5rem">
    {t("dmchat.e2e")}
  </p>
  {#if sharedEvents.length}
    <p class="muted" style="margin:0 0 0.5rem;font-size:0.85rem">
      {t("dmchat.sharedEvents")}
      {#each sharedEvents as e, i (e.naddr)}
        {#if i > 0}<span>, </span>{/if}<button
          style="background:none;border:none;padding:0;font:inherit;color:var(--accent);font-weight:600;cursor:pointer;text-decoration:underline"
          onclick={() => router.go({ name: "event", naddr: e.naddr })}
        >{e.title}</button>
      {/each}
    </p>
  {/if}
  {#if muted}
    <p class="muted" role="status" style="margin:0 0 0.5rem">{t("mute.confirm")}</p>
  {/if}

  {#if error}
    <ErrorState {error} body={mutes.unreadable ? "mute.unreadable" : undefined} />
  {/if}

  <!-- The transcript takes the height actually left on screen (fillHeight), so
       the composer sits just under it instead of floating above dead space. -->
  <div
    bind:this={scroller}
    use:fillHeight={{ below: composerEl, min: 200 }}
    class="card"
    style="height:50dvh;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:0.5rem"
  >
    {#if loading}
      <p class="muted">{t("dmchat.decrypting")}</p>
    {:else if messages.length === 0}
      <p class="muted">{t("dmchat.empty")}</p>
    {/if}
    {#each messages as m (m.id)}
      <div
        style="max-width:80%;padding:0.5rem 0.75rem;border-radius:12px;
          {m.from === m.peer
          ? 'align-self:flex-start;background:var(--bg-elev2)'
          : 'align-self:flex-end;background:var(--accent-soft)'}"
      >
        <span style="white-space:pre-wrap;word-break:break-word">{m.text}</span>
        <span class="muted" style="display:block;font-size:0.7rem;text-align:right">
          {#if m.queued}{t("dmchat.queued")} · {/if}{fmt(m.at)}
        </span>
      </div>
    {/each}
  </div>

  <!-- Sticky ABOVE the fixed bottom nav, the same way event chat's composer is
       (audit A-1): `fillHeight` normally leaves exactly enough room below the
       transcript, but it is a measurement, and a measurement can be wrong for a
       frame — or for good, if something above the pane grows after it ran. When
       that happened here the composer sat UNDER the nav bar and half of what you
       typed was invisible (2026-09-12). Sticky makes that unrepresentable: the
       composer cannot leave the band above the nav, whatever the pane measures.
       The slow-signer note lives inside the sticky block for the same reason. -->
  <div class="compose" bind:this={composerEl}>
    {#if sendSlow}
      <p class="muted" role="status" style="margin:0 0 0.4rem;font-size:0.85rem">{t("dmchat.signerSlow")}</p>
    {/if}
    <div class="row" style="align-items:flex-end">
      <textarea
        rows="2"
        use:autoGrow={draft}
        placeholder={t("dmchat.placeholder")}
        bind:value={draft}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      ></textarea>
      <button
        class="btn primary inline"
        style="flex:none"
        onclick={send}
        disabled={sending || !draft.trim()}
      >
        {sending ? "…" : t("dmchat.send")}
      </button>
    </div>
  </div>
{/if}

<style>
  /* The header wraps rather than squashing: avatar + name hold the first line
     and the action group drops below them on a narrow phone. */
  .hdr {
    gap: 0.75rem;
    margin: 1rem 0 0.5rem;
    flex-wrap: wrap;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: none;
    margin-left: auto;
  }
  .icon-btn {
    padding: 0.4rem 0.5rem;
    line-height: 0;
    flex: none;
  }
  /* --nav-band is the same allowance the shell reserves for the fixed bottom
     nav, so the two cannot drift apart (it includes the notch inset, which a
     hard-coded 5rem would miss). */
  .compose {
    position: sticky;
    bottom: var(--nav-band);
    padding: 0.5rem 0;
    background: var(--bg);
  }
  /* Grows with the draft (use:autoGrow) until it would eat the transcript;
     past that it scrolls. Manual resizing would fight the action. */
  .compose textarea {
    resize: none;
    max-height: 8rem;
  }
</style>
