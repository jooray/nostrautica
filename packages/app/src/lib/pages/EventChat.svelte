<script lang="ts">
  // Marmot group chat (MARMOT-GROUP-CHAT §7). Members-only, gated by
  // eventShell.showChat (chat=marmot + coordinator). The session itself is owned
  // by the shell (chat/session.svelte.ts) and prewarmed as soon as the viewer is
  // an approved member, so this page is a view over an already-running (usually
  // already-joined) session. The marmot-ts stack stays lazily imported there, so
  // chat-off events and non-members never pay for it. Alpha/experimental.
  import { onMount, tick, untrack } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { npubEncode } from "nostr-tools/nip19";
  import { sendDm } from "$lib/events/dm.js";
  import { parseDmCommand, matchDmTargets, type DmTarget } from "$lib/chat/dm-command.js";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    loadEventContext,
    cachedEventContext,
    ensureEventContext,
    type EventContext,
  } from "$lib/events/event-context.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import { receiveGrants, fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import { buildDeviceAccountMap, chatMembers } from "$lib/chat/members.js";
  import type { RosterContent } from "@nostrautica/protocol";
  import { evaluateChatGate, canEnterChatFromLocalState } from "$lib/chat/gate.js";
  import { chatSession, ChatUnroutableError } from "$lib/chat/session.svelte.js";
  import { fillHeight } from "$lib/components/fill-height.js";
  import { autoGrow } from "$lib/components/auto-grow.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { avatarHues } from "$lib/identity/avatar.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";
  import type { MessageKey } from "$lib/i18n/messages.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ChatHandoffCard from "$lib/components/ChatHandoffCard.svelte";
  import type { ChatMessage } from "$lib/chat/messages.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { saveDraft, loadDraft } from "$lib/stores/drafts.js";
  import { ownStatusStore } from "$lib/stores/own-status.svelte.js";
  import { perfMark } from "$lib/perf.js";

  /** Sender display: chat identities publish their own kind-0 (identity.ts —
   *  local-key accounts reuse the real profile; device-key accounts publish
   *  "<name> (chat)"), so resolving names/avatars is a plain profile fetch
   *  keyed by the message's chat-identity pubkey — no roster lookup needed. */
  type DisplayMode = "bubbles" | "irc";
  const DISPLAY_MODE_KEY = "nostrautica:chat-display-mode";
  function loadDisplayMode(): DisplayMode {
    try {
      return localStorage.getItem(DISPLAY_MODE_KEY) === "irc" ? "irc" : "bubbles";
    } catch {
      return "bubbles";
    }
  }

  let { naddr }: { naddr: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<unknown>(null);
  let sendError = $state<string | null>(null);
  /** The last send failed because this device is out of the group, not on the wire. */
  let sendUnroutable = $state(false);
  let rejoinError = $state<string | null>(null);
  let rejoined = $state(false);
  let draft = $state("");
  let sending = $state(false);

  // Draft-safe auto-refresh (App-2): persist the compose text (owner-scoped) and
  // hold the pending reload while it's non-empty; it applies once the box clears.
  $effect(() => {
    const text = draft;
    saveDraft(`chat:${naddr}`, text);
    if (text.trim().length > 0) return refreshGuard.hold("chat");
  });
  // Set once our own membership-resolve pass (grant fetch + shell re-sync) has run.
  let membershipKnown = $state(false);
  // The session itself lives in the shell (chat/session.svelte.ts), started as
  // soon as the shell knows we're an approved member — usually long before this
  // page mounts. So this page reads it rather than owning it: no re-handshake on
  // every visit, and the messages that arrived while the user was on other tabs
  // are already here.
  const messages = $derived(chatSession.messages);
  const chatPubkey = $derived(chatSession.chatPubkey);
  // Multi-tab (H-7): a read-only follower can't send from this tab — chat is
  // active in another tab, or Web Locks is unavailable. Show a notice + disable
  // the composer; the newest messages still render from the leader's broadcast.
  const readOnly = $derived(chatSession.readOnly);
  // Setup usually completes within seconds (member publishes key package →
  // coordinator adds them → welcome lands). If it's still spinning after a grace
  // period the coordinator may be slow/asleep or a socket dropped — surface a
  // gentle hint + a Try again that re-runs the handshake (no page reload).
  let setupSlow = $state(false);
  // Sender kind-0s (name/picture), keyed by chat-identity pubkey — filled in
  // reactively as new senders show up in `messages`.
  let profiles = $state<Map<string, ProfileMeta>>(new Map());
  let displayMode = $state<DisplayMode>(loadDisplayMode());
  // The ECK roster's chat_keys map every device key → its account, so N devices of
  // one person show as one member and one name/colour (NIP §10.1 dedupe).
  let roster = $state<RosterContent | undefined>(undefined);
  const deviceAccountMap = $derived(buildDeviceAccountMap(roster));
  // Real MLS membership when the session can see the group, roster `chat_keys`
  // (i.e. who ATTESTED) when it can't — the two disagree in both directions, so
  // the header says which one is on screen rather than passing one off as the
  // other. The coordinator's own admin leaf is in the group too and is excluded:
  // it is disclosed above ("coordinator-read"), not a person in the room.
  const memberList = $derived(
    chatMembers(roster, {
      groupDevices: chatSession.memberDevices,
      exclude: ctx?.config.coordinator ? [ctx.config.coordinator] : [],
    }),
  );
  const members = $derived(memberList.members);
  function accountOf(pubkey: string): string {
    return deviceAccountMap.get(pubkey) ?? pubkey;
  }
  let showMembers = $state(false);

  function setDisplayMode(mode: DisplayMode): void {
    displayMode = mode;
    try {
      localStorage.setItem(DISPLAY_MODE_KEY, mode);
    } catch {
      /* storage unavailable — preference stays in-memory only */
    }
  }

  onMount(async () => {
    // Restore a compose draft left by a previous session/refresh (App-2).
    if (!draft && session.pubkey) {
      const saved = loadDraft(`chat:${naddr}`);
      if (saved) draft = saved;
    }
    // The event context is public (31600 + 31923 + kind-0) and cached across
    // reloads, so read it before anything async: the room needs it for the
    // coordinator identity and the relay set, and awaiting a relay for a copy we
    // already hold was the first of four round-trips this mount used to serialise.
    const cached = cachedEventContext(naddr);
    if (cached) ctx = cached;

    // ── Fast path: this device already knows it is a member ───────────────────
    // "Checking your access…" (`chat.checking`) used to cover a full network re-derivation of
    // something already settled: connect → 31600/31923 fetch → a paged gift-wrap
    // grant scan (two signer round-trips per unprocessed wrap, i.e. an Amber
    // prompt storm on a remote signer) → a shell re-sync. Every one of those ran
    // on EVERY open, and on a repeat open none of them could change the answer:
    // membership in an event's chat is an ECK in THIS device's keystore, which
    // `eventShell` has already resolved for this event (it resolves the role from
    // local custody, deliberately without waiting for a relay).
    //
    // This is not an optimistic paint (see gate.ts): the predicate is the gate's
    // own, and nothing below widens it. A non-member, a fresh device, or a deep
    // link that beat the shell still falls through to the honest pass.
    if (
      cached &&
      canEnterChatFromLocalState({
        membershipKnown: true,
        shellNaddr: eventShell.naddr,
        naddr,
        loading: eventShell.loading,
        showChat: eventShell.showChat,
        hasSigner: !!session.signer,
        hasCtx: true,
      })
    ) {
      // Release the gate BEFORE any await — this is the whole point.
      membershipKnown = true;
      roster = cachedRoster(cached.coordinate);
      void refreshInBackground(cached);
      return;
    }

    // ── Slow path: membership is genuinely unknown on this device ─────────────
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Bug 3: membership is resolved asynchronously and decoupled from this mount.
      // A deep link straight to chat can arrive before EventHome ingested the ECK
      // grant, so actively fetch it here, then re-sync the shell so `showChat`
      // reflects it. The reactive gate below then settles correctly instead of
      // latching "not a member yet" on a lost race.
      if (session.signer) {
        await receiveGrants(session.signer).catch(() => {});
        await eventShell.sync(naddr);
      }
      // Roster carries the device→account map (chat_keys) for member/name dedupe.
      roster = cachedRoster(ctx.coordinate);
      void fetchRoster(ctx)
        .then((r) => {
          if (r) roster = r;
        })
        .catch(() => {});
    } catch (e) {
      error = e;
    } finally {
      // Membership is now genuinely known (member or not) — release the gate.
      membershipKnown = true;
    }
  });

  /**
   * Fast-path follow-up: refresh what the room shows, without ever reopening the
   * gate that is now (correctly) settled.
   *
   * Two things are deliberately NOT done here. `eventShell.sync()` is not called:
   * it sets `eventShell.loading`, which `evaluateChatGate` reads as "membership
   * unknown", so a background sync would drop a rendered room back to "Checking
   * your access…" seconds after opening it. `refreshRole()` does the part that
   * matters — re-resolve the role from local custody — and is network-free, so a
   * membership that has genuinely gone away still closes the room reactively.
   *
   * `receiveGrants` is not called either: an ECK grant scan cannot make an
   * already-approved member any more approved for THIS event, and on a remote
   * signer it is two NIP-46 round-trips per unprocessed wrap. Ingesting new
   * grants stays where it belongs — the identity-level warmers and EventHome's
   * approval poll, which run whether or not chat is ever opened.
   */
  async function refreshInBackground(context: EventContext): Promise<void> {
    try {
      await connectNdk();
      // Public context, SWR: cached copy already applied above; this only lands a
      // newer one (e.g. the organizer swapped the coordinator or a relay).
      void ensureEventContext(naddr, (fresh) => {
        ctx = fresh;
      }).catch(() => {});
      const fresh = await fetchRoster(context).catch(() => undefined);
      if (fresh) roster = fresh;
      await eventShell.refreshRole().catch(() => {});
    } catch {
      /* the room is already usable from local state — a failed refresh is not an
         error the user needs to see, and `chatSession` reports real chat faults */
    }
  }

  // No dispose here: the session outlives this page (it belongs to the event),
  // and the layout tears it down when the user leaves the event or logs out.

  // Reactive membership gate (Bug 3). Re-evaluates whenever the event-shell's
  // roster/ECK/membership state resolves, so a late-resolving Add transitions the
  // page from "loading" into setup/ready instead of stranding on the negative.
  // The gate can only settle "unavailable" once membership is genuinely known.
  const gate = $derived(
    evaluateChatGate({
      membershipKnown,
      shellNaddr: eventShell.naddr,
      naddr,
      loading: eventShell.loading,
      showChat: eventShell.showChat,
      hasSigner: !!session.signer,
    }),
  );

  // The layout's prewarm normally has the session running already; this covers
  // the deep-link case (straight to /chat, membership resolved here first) and
  // skips the prewarm's deliberate delay. `ensure` is idempotent — a call for an
  // already-running session adopts it instead of re-handshaking.
  $effect(() => {
    if (error || gate !== "enter" || !ctx || !session.signer) return;
    const signer = session.signer;
    const owner = session.pubkey;
    const context = ctx;
    // untrack: `ensure` reads (and settles) the session's own state; this effect
    // should depend only on the gate/context above, not re-fire on its writes.
    untrack(() => void chatSession.ensure(naddr, context, signer, owner).catch(() => {}));
  });

  const phase = $derived.by<"loading" | "setup" | "evicted" | "ready" | "unavailable">(() => {
    if (error || chatSession.error) return "unavailable";
    if (gate === "loading") return "loading";
    if (gate === "unavailable") return "unavailable";
    // "evicted" is NOT a kind of "setup": setup is a room that hasn't happened
    // yet, whose remedy is waiting (and, once slow, Rejoin). Eviction is a room
    // that stopped, whose remedy is Rejoin and only Rejoin — and whose history is
    // still on screen, so the setup empty-state that carries the escalation would
    // never render for it.
    if (chatSession.phase === "evicted") return "evicted";
    return chatSession.phase === "ready" ? "ready" : "setup";
  });

  // Perf instrumentation (perf.ts), measured from the route change that brought
  // the user here — the owner's complaint is literally "tap Chat, wait". The two
  // phases mean something specific for this page:
  //   cache-paint     — the room itself is on screen (history, members, the
  //                     composer), i.e. "Checking your access…" is gone.
  //   network-settled — the composer is LIVE: the MLS group is joined and a
  //                     message can actually be sent. On a prewarmed session this
  //                     lands with the paint; on a first ever open it waits for
  //                     the coordinator's Add + welcome, which is the honest
  //                     enrolment cost and worth seeing separately.
  $effect(() => {
    if (phase === "setup" || phase === "evicted" || phase === "ready") {
      perfMark("EventChat", "cache-paint");
    }
    if (phase === "ready") perfMark("EventChat", "network-settled");
  });

  // Show the "taking longer than usual" hint if we're still in setup after a
  // grace period; clear it whenever we leave setup. Reruns cleanly on retry.
  $effect(() => {
    if (phase !== "setup") {
      setupSlow = false;
      return;
    }
    const id = setTimeout(() => (setupSlow = true), 25000);
    return () => clearTimeout(id);
  });

  // Re-run the handshake without reloading the page: tear down the half-open
  // session and start fresh. Republishes the key package so the coordinator gets
  // another chance to add us, and reopens the subscription sockets.
  async function retryChat() {
    setupSlow = false;
    await chatSession.retry();
  }

  // Re-enrol this device (chat/client.ts rejoin). Offered next to a failed send:
  // that failure means this session holds no routable group, and no amount of
  // retrying the send fixes it — the coordinator has to add this device again.
  async function rejoin() {
    sendError = null;
    sendUnroutable = false;
    rejoinError = null;
    rejoined = false;
    try {
      // Forced: this button is only reachable after a send has actually failed or
      // setup has stalled, so the user's evidence outranks our own membership
      // bookkeeping — which can be stale in exactly the case they're stuck in.
      await chatSession.rejoin({ force: true });
      rejoined = true;
    } catch {
      rejoinError = t("chat.rejoinFailed");
    }
  }

  async function send() {
    const text = draft.trim();
    // A leader has its own client; an interactive follower proxies through the
    // leader tab (chatSession.send). Only a read-only follower can't send.
    if (!text || sending || readOnly) return;
    // Defence in depth: the composer's Enter is intercepted and the Send button
    // is disabled while a slash command owns the line, but this is the one
    // mistake with a real cost — broadcasting a message meant for one person to
    // the whole room — so the send path refuses it as well.
    if (dmCommand) return;
    sending = true;
    sendError = null;
    sendUnroutable = false;
    try {
      await chatSession.send(text);
      draft = "";
      // A message got through — retire any leftover recovery notice.
      rejoined = false;
      rejoinError = null;
    } catch (e) {
      // Bug 5: surface the failure instead of silently swallowing it. A revoked
      // (removed) attendee's send lands here once they've lost the group locally.
      // Which of the two it was decides what to OFFER: Rejoin revokes this device,
      // rotates its key package and re-attests — an MLS epoch change and a roster
      // republish. Right for a lost membership, wrong for a dropped socket, where
      // the message is still in the composer and pressing Send again is the whole
      // remedy.
      sendUnroutable = e instanceof ChatUnroutableError;
      sendError = sendUnroutable ? t("chat.sendFailed") : t("chat.sendFailedTransport");
    } finally {
      sending = false;
    }
  }

  // ── the message pane scrolls on its own ─────────────────────────────────────
  // A long event's chat is long; letting it grow the page means the composer
  // walks off the bottom and every visit lands you at the oldest message. The
  // pane is a fixed-height scroller pinned to the newest message instead — but
  // only while the reader is *at* the bottom: scrolling up to read history must
  // not be yanked away by an arriving message. When one arrives while you're up
  // there, a "new messages" button appears rather than a jump.
  let listEl = $state<HTMLElement | null>(null);
  /** The composer — reserved space under the pane (see `fillHeight`). */
  let composerEl = $state<HTMLElement | null>(null);
  /** Reader is at (or within a line or two of) the newest message. */
  let atBottom = $state(true);
  /** Messages arrived while the reader was scrolled up. */
  let unseen = $state(false);

  function scrollToLatest(behavior: ScrollBehavior = "smooth"): void {
    listEl?.scrollTo({ top: listEl.scrollHeight, behavior });
    unseen = false;
  }

  function onScroll(): void {
    if (!listEl) return;
    atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
    if (atBottom) unseen = false;
  }

  // Follow the tail as messages land (or as the history replay fills the pane on
  // first paint — that one must be instant, not an animated crawl through the
  // whole backlog).
  let painted = false;
  $effect(() => {
    void messages.length;
    if (!listEl) return;
    const first = !painted;
    painted = true;
    if (untrack(() => atBottom)) {
      // After the DOM has the new nodes.
      void tick().then(() => scrollToLatest(first ? "instant" : "smooth"));
    } else {
      unseen = true;
    }
  });

  function dayLabel(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString();
  }
  function timeLabel(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // Group messages by calendar day for the day separators.
  const grouped = $derived.by(() => {
    const out: { day: string; items: ChatMessage[] }[] = [];
    for (const m of messages) {
      const day = dayLabel(m.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  });

  // Resolve sender names/avatars for every pubkey that's shown up so far:
  // cache-first paint, then a relay round-trip for anything missing/stale.
  // Dedup guard is plain (non-reactive) — it only decides what to re-fetch.
  const fetchedProfileFor = new Set<string>();
  $effect(() => {
    // Fetch both the device kind-0 (fallback name) and the account it maps to
    // (primary name), plus every chat member's account for the member list.
    const wanted = new Set<string>();
    for (const m of messages) {
      wanted.add(m.pubkey);
      wanted.add(accountOf(m.pubkey));
    }
    for (const mem of members) wanted.add(mem.account);
    const missing = [...wanted].filter((pk) => !fetchedProfileFor.has(pk));
    if (missing.length === 0) return;
    for (const pk of missing) fetchedProfileFor.add(pk);
    const cached = cachedProfiles(missing);
    if (cached.size) profiles = new Map([...profiles, ...cached]);
    void fetchProfiles(missing).then((fresh) => {
      if (fresh.size) profiles = new Map([...profiles, ...fresh]);
    });
  });

  // The chat-key kind-0 (identity.ts buildChatKeyProfile) reads "Nostrautica
  // <name> (chat)" so OTHER Marmot clients can tell this npub is an app-scoped
  // child key, not a person — useful context there, but redundant noise here
  // where every sender in view already is one; strip it for our own display
  // only (the published kind-0 keeps the full branding).
  function nameOf(pubkey: string): string {
    // Resolve the device sender to its account name first (roster mapping), then
    // fall back to the device's own kind-0, then a truncated key.
    const account = accountOf(pubkey);
    const raw = (profiles.get(account)?.name ?? profiles.get(pubkey)?.name)?.trim();
    if (!raw) return account.slice(0, 8);
    return raw.replace(/^Nostrautica\s+/i, "").replace(/\s*\(chat\)\s*$/i, "");
  }
  function pictureOf(pubkey: string): string | undefined {
    const account = accountOf(pubkey);
    return profiles.get(account)?.picture ?? profiles.get(pubkey)?.picture;
  }
  // Deterministic per-PERSON hue (shared with Avatar's gradient) for the IRC nick
  // colour — keyed by account, so two devices of one person render one colour.
  function nickHue(pubkey: string): string {
    return avatarHues(accountOf(pubkey))[0].toFixed(0);
  }
  // Plural-aware "N devices" affix for a chat member.
  function devicesLabel(n: number): string {
    return tp("chat.members.devices", n);
  }

  // ── who is that? ────────────────────────────────────────────────────────────
  // Every sender in here is a chat DEVICE key; the person is the ACCOUNT it maps
  // to (roster chat_keys), which is also the pubkey the attendee page is keyed by.
  // Going through accountOf matters for anyone with two devices: both of their
  // bubbles must open one profile, not two npubs that look like strangers.
  function openProfile(pubkey: string): void {
    router.go({ name: "attendee", naddr, npub: npubEncode(accountOf(pubkey)) });
  }

  /**
   * A bubble is a click target AND selectable text, and the text has to win: a
   * click that ends a selection is the user copying a message, not asking for a
   * profile. Without this, every attempt to copy someone's message navigates
   * away and loses the selection.
   */
  function openProfileUnlessSelecting(pubkey: string): void {
    if (typeof window !== "undefined" && (window.getSelection()?.toString() ?? "") !== "") return;
    openProfile(pubkey);
  }

  // ── /m and /msg (IRC) ───────────────────────────────────────────────────────
  // `/msg <nick> <text>` sends a NIP-17 DM and leaves for that conversation, and
  // `/msg <nick>` alone just opens it — the same split IRC has between /msg and
  // /query. The parsing lives in lib/chat/dm-command.ts, where the multi-word
  // name cases are pinned as tests; the DM goes to the ACCOUNT, never the chat
  // device key, which is app-scoped and would deliver nowhere else.

  /** Everyone in the room except yourself. */
  const dmTargets = $derived.by(() => {
    const me = chatPubkey ? accountOf(chatPubkey) : "";
    return members
      .map((mem) => ({ account: mem.account, name: nameOf(mem.account) }))
      .filter((x) => x.account !== me)
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  const dmCommand = $derived(parseDmCommand(draft, dmTargets));
  const dmMatches = $derived(
    dmCommand && !dmCommand.ready ? matchDmTargets(dmTargets, dmCommand.query) : [],
  );

  let dmPick = $state(0);
  let dmBusy = $state(false);
  let dmError = $state<string | null>(null);
  // Keep the highlighted row inside the list as it shrinks under the typing.
  $effect(() => {
    if (dmPick >= dmMatches.length) dmPick = 0;
  });

  /** Complete the composer to `/msg <name> ` and let them type the message. */
  function completeNick(target: DmTarget): void {
    draft = `/msg ${target.name} `;
    dmError = null;
  }

  async function runDmCommand(target: DmTarget, body: string): Promise<void> {
    if (dmBusy || !session.signer) return;
    dmBusy = true;
    dmError = null;
    try {
      if (body) {
        // Same contract as the DM screen: `false` means every publish retry
        // failed and the wrap is in the durable queue, so say "queued" rather
        // than implying it left the device.
        const published = await sendDm(session.signer, target.account, body);
        if (!published) outbox.noteQueued();
      }
      draft = "";
      router.go({ name: "dmPeer", npub: npubEncode(target.account) });
    } catch (e) {
      dmError = e instanceof Error ? e.message : String(e);
    } finally {
      dmBusy = false;
    }
  }

  /**
   * The composer's Enter, when a slash command owns the line. Returns true when
   * it handled the key, so the normal group-chat send never also runs — sending
   * "/msg Juraj hi" to the whole room is the failure this guards.
   */
  function handleCommandKey(e: KeyboardEvent): boolean {
    if (!dmCommand) return false;
    if (!dmCommand.ready) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (dmMatches.length === 0) return false;
        e.preventDefault();
        dmPick = (dmPick + (e.key === "ArrowDown" ? 1 : dmMatches.length - 1)) % dmMatches.length;
        return true;
      }
      if (e.key === "Escape" && dmMatches.length) {
        e.preventDefault();
        draft = "";
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const pick = dmMatches[dmPick];
        if (!pick) {
          // A command with no match must not fall through to the room.
          if (e.key === "Enter") {
            e.preventDefault();
            dmError = t("chat.cmd.noSuchPerson");
            return true;
          }
          return false;
        }
        e.preventDefault();
        completeNick(pick);
        return true;
      }
      return false;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runDmCommand(dmCommand.target, dmCommand.body);
      return true;
    }
    return false;
  }

  // ── why setup is stuck, when the coordinator actually told us ───────────────
  // A refused 21607 (device cap, a chat key bound to someone else, a bad proof of
  // possession, an unusable key package) used to be a line in the coordinator's
  // log and nothing else: this device sat in "setting up your secure chat" with a
  // generic "it may be offline, check with the organizer" hint that pointed at the
  // wrong thing entirely. The coordinator now seals the reason to the affected
  // attendee over the same 21606 channel a failed talk/submission already uses
  // (`stage: "chat_attestation"`), and the grant scan records it here.
  const CHAT_STAGE = "chat_attestation";
  const refusal = $derived.by(() => {
    if (!ctx) return undefined;
    const notice = ownStatusStore
      .poison(ctx.coordinate)
      .filter((s) => s.stage === CHAT_STAGE)
      .sort((a, b) => b.at - a.at)[0];
    if (!notice) return undefined;
    // The category is a stable sanitized class, never free text — an unknown one
    // (a newer coordinator) falls back to a generic line rather than rendering a
    // raw identifier at the user.
    const known: Record<string, MessageKey> = {
      chat_device_cap_reached: "chat.refused.deviceCap",
      chat_key_bound_to_other_account: "chat.refused.boundElsewhere",
      chat_proof_invalid: "chat.refused.proof",
      chat_key_package_ineligible: "chat.refused.keyPackage",
    };
    return t(known[notice.error_category ?? ""] ?? "chat.refused.other");
  });
</script>

<div class="chat-head">
  <h1 class="disp">{t("chat.title")}</h1>
  <span class="badge">{t("chat.experimental")}</span>
</div>

<!-- All chats (this event's + every other event's + DMs) live one tap away
     (user feedback 2026-07-20) — this tab itself stays the fast path straight
     into THIS event's chat. A full-width row with its own icon reads as a
     real destination, not a footnote (the earlier small corner text link
     tested as easy to miss entirely). -->
<button class="all-chats-btn" onclick={() => router.go({ name: "dm" })}>
  <Icon name="people" size={18} />
  <span>{t("chat.allConversations")}</span>
  <Icon name="arrowUpRight" size={16} />
</button>

<!-- Coordinator-read + from-join-epoch disclosure (§4.5). Always shown. -->
<div class="disclosure" role="note">
  <Icon name="info" size={18} />
  <p>{t("chat.disclosure.body")}</p>
</div>

{#if phase === "unavailable"}
  {#if error || chatSession.error}
    <ErrorState error={error ?? chatSession.error} />
  {:else}
    <div class="card"><p class="muted">{t("chat.unavailable")}</p>
      <button class="btn" onclick={() => router.go({ name: "event", naddr })}>{t("chat.backToEvent")}</button>
    </div>
  {/if}
{:else if phase === "loading"}
  <p class="muted">{t("chat.checking")}</p>
{:else}
  {#if phase === "evicted"}
    <!-- Above the messages, not inside the empty state: an evicted member still
         has their whole decrypted history on screen, so the empty state — where
         the Rejoin escalation used to live — never renders for them. They saw a
         normal-looking room in which nothing new ever arrived. -->
    <div class="card warn" role="alert">
      <strong>{t("chat.evicted.title")}</strong>
      <p class="muted" style="margin:0.3rem 0 0.6rem">{t("chat.evicted.body")}</p>
      <button class="btn primary" disabled={chatSession.rejoining} onclick={() => void rejoin()}>
        {chatSession.rejoining ? t("chat.rejoining") : t("chat.rejoin")}
      </button>
      {#if rejoinError}
        <p class="send-error" role="alert" style="margin:0.5rem 0 0">{rejoinError}</p>
      {:else if rejoined}
        <p class="muted rejoin-note" role="status" style="margin:0.5rem 0 0">{t("chat.rejoinRequested")}</p>
      {/if}
    </div>
  {/if}
  <div class="display-toggle" role="group" aria-label={t("chat.display.label")}>
    <button
      class="btn inline"
      aria-pressed={displayMode === "bubbles"}
      class:primary={displayMode === "bubbles"}
      onclick={() => setDisplayMode("bubbles")}
    >
      {t("chat.display.bubbles")}
    </button>
    <button
      class="btn inline"
      aria-pressed={displayMode === "irc"}
      class:primary={displayMode === "irc"}
      onclick={() => setDisplayMode("irc")}
    >
      {t("chat.display.irc")}
    </button>
  </div>

  <!-- One entry per person (roster chat_keys dedupe): N devices of one account
       collapse into one member, with a subtle "N devices" affix. -->
  {#if members.length > 0}
    <details class="members" bind:open={showMembers}>
      <summary>
        {t("chat.members.title")} · {members.length}{#if memberList.source === "attested"}
          <span class="msource">{t("chat.members.attested")}</span>
        {/if}
      </summary>
      <ul>
        {#each members as mem (mem.account)}
          <li>
            <Avatar pubkey={mem.account} name={nameOf(mem.account)} picture={pictureOf(mem.account)} size={22} />
            <span class="mname">{nameOf(mem.account)}</span>
            {#if mem.deviceCount > 1}<span class="devcount">{devicesLabel(mem.deviceCount)}</span>{/if}
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  <!-- A scroll container must be reachable by keyboard (WCAG 2.1.1) — the
       noninteractive-tabindex rule doesn't account for scrollable regions. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="messages"
    class:irc={displayMode === "irc"}
    bind:this={listEl}
    use:fillHeight={{ below: composerEl, min: 220 }}
    onscroll={onScroll}
    role="log"
    aria-live="polite"
    aria-label={t("chat.title")}
    tabindex="0"
  >
    {#if messages.length === 0}
      <div class="empty">
        {#if phase === "setup"}
          <p class="muted">{t("chat.setup")}</p>
          {#if refusal}
            <!-- We know exactly why, so say it instead of the generic hint. -->
            <p class="muted" style="margin-top:0.5rem" role="status">{refusal}</p>
          {/if}
          {#if setupSlow}
            {#if !refusal}
              <p class="muted" style="margin-top:0.5rem">{t("chat.setupSlow")}</p>
            {/if}
            <button class="btn inline" style="margin-top:0.25rem" onclick={retryChat}>
              {t("chat.retry")}
            </button>
            <!-- Setup that never finishes is the OTHER face of the failed send:
                 this device is attested (it's in the device list below) but the
                 coordinator's Add never reached it, and re-running the handshake
                 can't fix that — re-advertising the same key package is a no-op on
                 both sides. Offer the re-enrolment as the escalation. -->
            <p class="muted" style="margin-top:0.6rem">{t("chat.rejoinHint")}</p>
            <button
              class="btn inline"
              style="margin-top:0.25rem"
              disabled={chatSession.rejoining}
              onclick={() => void rejoin()}
            >
              {chatSession.rejoining ? t("chat.rejoining") : t("chat.rejoin")}
            </button>
          {/if}
        {:else}
          <p class="muted">{t("chat.empty")}</p>
        {/if}
      </div>
    {:else}
      {#each grouped as g (g.day)}
        <div class="day" class:irc={displayMode === "irc"}><span>{g.day}</span></div>
        {#each g.items as m, i (m.id)}
          {@const mine = m.pubkey === chatPubkey}
          {#if displayMode === "irc"}
            <p class="irc-line">
              <span class="irc-time">{timeLabel(m.createdAt)}</span>
              <button
                type="button"
                class="irc-nick linklike"
                style="--nick-h:{nickHue(m.pubkey)}"
                title={t("chat.openProfileOf", { name: nameOf(m.pubkey) })}
                onclick={() => openProfile(m.pubkey)}
              >&lt;{nameOf(m.pubkey)}&gt;</button>
              <span class="irc-text">{m.content}</span>
            </p>
          {:else}
            {@const showSender = i === 0 || g.items[i - 1]!.pubkey !== m.pubkey}
            <div class="msg" class:mine>
              {#if showSender}
                <button
                  type="button"
                  class="avatar-btn"
                  title={t("chat.openProfileOf", { name: nameOf(m.pubkey) })}
                  aria-label={t("chat.openProfileOf", { name: nameOf(m.pubkey) })}
                  onclick={() => openProfile(m.pubkey)}
                >
                  <Avatar
                    pubkey={accountOf(m.pubkey)}
                    name={nameOf(m.pubkey)}
                    picture={pictureOf(m.pubkey)}
                    size={26}
                  />
                </button>
              {:else}
                <span class="avatar-spacer" aria-hidden="true"></span>
              {/if}
              <div class="col">
                {#if showSender}
                  <button
                    type="button"
                    class="sender linklike"
                    title={t("chat.openProfileOf", { name: nameOf(m.pubkey) })}
                    onclick={() => openProfile(m.pubkey)}
                  >{nameOf(m.pubkey)}</button>
                {/if}
                <!-- The bubble opens the profile too (user request 2026-09-10).
                     role/tabindex rather than a <button> so the message stays
                     ordinary selectable text, and the click is ignored mid
                     selection — see openProfileUnlessSelecting. -->
                <div
                  class="bubble"
                  role="button"
                  tabindex="0"
                  title={t("chat.openProfileOf", { name: nameOf(m.pubkey) })}
                  onclick={() => openProfileUnlessSelecting(m.pubkey)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openProfile(m.pubkey);
                    }
                  }}
                >
                  <p class="text">{m.content}</p>
                  <span class="time">{timeLabel(m.createdAt)}</span>
                </div>
              </div>
            </div>
          {/if}
        {/each}
      {/each}
    {/if}
  </div>

  {#if unseen}
    <div class="jump-row">
      <button class="btn inline jump" onclick={() => scrollToLatest()}>
        {t("chat.jumpToLatest")}
      </button>
    </div>
  {/if}

  {#if readOnly}
    <div class="disclosure" role="note">
      <Icon name="info" size={18} />
      <div>
        <p style="font-weight:650">{t("chat.otherTab.title")}</p>
        <p>{t("chat.otherTab.body")}</p>
      </div>
    </div>
  {:else}
    <form class="compose" bind:this={composerEl} onsubmit={(e) => { e.preventDefault(); void send(); }}>
      <!-- /m · /msg autocomplete. Above the composer, so it never covers the
           message it is helping to address. -->
      {#if dmCommand && !dmCommand.ready && dmMatches.length > 0}
        <ul class="nickpop" role="listbox" aria-label={t("chat.cmd.pickPerson")}>
          {#each dmMatches as c, i (c.account)}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={i === dmPick}
                class:on={i === dmPick}
                onmouseenter={() => (dmPick = i)}
                onclick={() => completeNick(c)}
              >
                <Avatar pubkey={c.account} name={c.name} size={20} />
                <span>{c.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if dmCommand?.ready}
        <p class="cmdhint" role="status">
          {dmCommand.body
            ? t("chat.cmd.willSend", { name: dmCommand.target.name })
            : t("chat.cmd.willOpen", { name: dmCommand.target.name })}
        </p>
      {/if}
      <textarea
        bind:value={draft}
        rows="1"
        use:autoGrow={draft}
        placeholder={t("chat.compose.placeholder")}
        disabled={phase === "setup" || phase === "evicted"}
        onkeydown={(e) => {
          if (handleCommandKey(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      ></textarea>
      <button
        class="send"
        type="submit"
        disabled={!draft.trim() || sending || dmBusy || !!dmCommand || phase === "setup" || phase === "evicted"}
        aria-label={dmCommand ? t("chat.cmd.pickPerson") : t("chat.send")}
      >
        <Icon name="send" size={20} />
      </button>
    </form>
    {#if dmError}
      <p class="send-error" role="alert">{dmError}</p>
    {/if}
  {/if}

  <!-- A failed send is "this device is no longer in the group", not "try again
       later" — so the recovery offered here re-enrols the device rather than
       re-sending. The message survives in the composer; it can be sent once the
       coordinator's welcome lands. -->
  {#if sendError}
    <p class="send-error" role="alert">{sendError}</p>
    {#if sendUnroutable}
      <button class="btn inline" disabled={chatSession.rejoining} onclick={() => void rejoin()}>
        {chatSession.rejoining ? t("chat.rejoining") : t("chat.rejoin")}
      </button>
    {:else}
      <!-- A transport failure. The text is still in the composer, so the remedy is
           the button that is already there — say so rather than offering an epoch
           change for a dropped socket. Rejoin stays available in the handoff card
           below for anyone whose retries keep failing. -->
      <button class="btn inline" disabled={sending} onclick={() => void send()}>
        {sending ? t("chat.sending") : t("chat.sendRetry")}
      </button>
    {/if}
  {/if}
  {#if rejoinError}
    <p class="send-error" role="alert">{rejoinError}</p>
  {:else if rejoined}
    <p class="muted rejoin-note" role="status">{t("chat.rejoinRequested")}</p>
  {/if}

  {#if ctx}
    <ChatHandoffCard {ctx} />
  {/if}
{/if}

<style>
  .chat-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .all-chats-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    margin: 0.6rem 0 0;
    padding: 0.6rem 0.75rem;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
    font: inherit;
    font-size: 0.88rem;
    font-weight: 650;
    cursor: pointer;
  }
  .all-chats-btn span {
    flex: 1;
    text-align: left;
  }
  .all-chats-btn :global(svg:first-child) {
    color: var(--accent);
    flex: none;
  }
  .all-chats-btn :global(svg:last-child) {
    color: var(--text-dim);
    flex: none;
  }
  .disclosure {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    padding: 0.6rem 0.75rem;
    margin: 0.75rem 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-raised) 70%, transparent);
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .disclosure p {
    margin: 0;
  }
  .display-toggle {
    display: flex;
    gap: 0.4rem;
    margin: 0.6rem 0 0.25rem;
  }
  .members {
    margin: 0.1rem 0 0.35rem;
    font-size: 0.85rem;
  }
  .members summary {
    cursor: pointer;
    color: var(--text-dim);
    padding: 0.2rem 0;
  }
  .members ul {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .members li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .members .mname {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .members .msource {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--text-dim);
  }
  .members .devcount {
    font-size: 0.72rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
  }
  .messages {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    /* Its own scroller, so the composer stays put and the page never grows with
       the backlog. `fillHeight` replaces this with the measured remaining height;
       the dvh value is the pre-action (and no-JS) fallback. */
    height: 48dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.25rem 0.5rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-raised) 30%, transparent);
  }
  .jump-row {
    display: flex;
    justify-content: center;
    margin-top: -0.6rem;
    /* Sits over the pane's bottom edge without taking layout height from it. */
    height: 0;
  }
  .jump {
    transform: translateY(-0.4rem);
    border-radius: 999px;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.35);
    background: var(--bg-raised);
  }
  .messages.irc {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    gap: 0.15rem;
  }
  .empty {
    margin: auto;
    text-align: center;
  }
  .day {
    text-align: center;
    margin: 0.6rem 0 0.2rem;
  }
  .day span {
    font-size: 0.72rem;
    color: var(--text-dim);
    background: var(--bg-raised);
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
  }
  .day.irc span {
    background: none;
    border-radius: 0;
    padding: 0;
  }
  .day.irc span::before {
    content: "— ";
  }
  .day.irc span::after {
    content: " —";
  }
  .msg {
    display: flex;
    gap: 0.4rem;
    align-items: flex-end;
    justify-content: flex-start;
  }
  .msg.mine {
    /* Same avatar-then-col DOM order as everyone else — reversing the axis
       (rather than swapping markup) puts the avatar on the right, hugging the
       far edge, with justify-content: flex-start (inherited above) now
       packing the whole group against that reversed start = the right side. */
    flex-direction: row-reverse;
  }
  /* Consecutive-same-sender messages get no gap of their own — .messages'
     gap already separates them from the PRECEDING (different-sender) group;
     stacking snugly here is what makes them read as one person talking. */
  .msg + .msg {
    margin-top: -0.2rem;
  }
  .avatar-spacer {
    width: 26px;
    flex: none;
  }
  .col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 78%;
  }
  .sender {
    font-size: 0.72rem;
    font-weight: 650;
    color: var(--text-dim);
    margin: 0 0 0.05rem 0.2rem;
    line-height: 1.2;
  }
  .msg.mine .sender {
    margin: 0 0.2rem 0.05rem 0;
    text-align: right;
  }
  .bubble {
    padding: 0.35rem 0.6rem;
    border-radius: 14px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
  }
  .msg.mine .bubble {
    background: color-mix(in srgb, var(--accent) 18%, var(--bg-raised));
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .time {
    display: block;
    text-align: right;
    font-size: 0.65rem;
    color: var(--text-dim);
    margin-top: 0.05rem;
  }
  /* IRC mode: plain log lines, no bubbles — `[time] <nick> text`. Nick colour
     is deterministic per sender (Avatar's hue) so the same person reads the
     same colour in both display modes; shape (the <angle-bracket> nick, not
     colour alone) still carries "who said this" per A6. */
  .irc-line {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .irc-time {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .irc-nick {
    font-weight: 700;
    color: hsl(var(--nick-h) 70% 68%);
  }
  :global([data-theme="light"]) .irc-nick {
    color: hsl(var(--nick-h) 65% 38%);
  }
  .irc-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Sender name, avatar and bubble all open the profile (user request
     2026-09-10). They are buttons/click targets, so every inherited button
     chrome has to be stripped back to the text that was there before. */
  .sender.linklike,
  .irc-nick.linklike {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .sender.linklike {
    font-size: 0.72rem;
    font-weight: 650;
    color: var(--text-dim);
    align-self: flex-start;
  }
  .msg.mine .sender.linklike {
    align-self: flex-end;
  }
  .irc-nick.linklike {
    font-weight: 700;
    color: hsl(var(--nick-h) 70% 68%);
  }
  :global([data-theme="light"]) .irc-nick.linklike {
    color: hsl(var(--nick-h) 65% 38%);
  }
  .sender.linklike:hover,
  .irc-nick.linklike:hover {
    text-decoration: underline;
  }
  .avatar-btn {
    background: none;
    border: none;
    padding: 0;
    line-height: 0;
    cursor: pointer;
    flex: none;
    border-radius: 50%;
  }
  .bubble {
    cursor: pointer;
  }
  /* Keyboard focus has to be visible on a div that behaves like a button. */
  .bubble:focus-visible,
  .avatar-btn:focus-visible,
  .sender.linklike:focus-visible,
  .irc-nick.linklike:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* /m · /msg autocomplete */
  .nickpop {
    position: absolute;
    bottom: calc(100% + 0.35rem);
    left: 0;
    right: 0;
    z-index: 5;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    max-height: 13rem;
    overflow-y: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
  }
  .nickpop button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.35rem 0.45rem;
    background: none;
    border: none;
    border-radius: 7px;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .nickpop button.on {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .cmdhint {
    position: absolute;
    bottom: calc(100% + 0.35rem);
    left: 0;
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .compose {
    position: sticky;
    /* ABOVE the fixed bottom nav, not under it (audit A-1). `bottom: 0` pins the
       composer to the bottom of the SCROLLPORT, which is exactly where the fixed
       nav is — so once the page was tall enough for the composer to be pinned at
       all (any desktop-width window: the e2e project runs 1280x720), the nav
       covered it and a click on Send landed on the nav's Updates tab instead.
       --nav-band is the same allowance the shell reserves for that bar, so the
       two can no longer drift apart. */
    bottom: var(--nav-band);
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    padding: 0.5rem 0;
    background: var(--bg);
  }
  /* One row at rest, growing with the draft (use:autoGrow) to max-height, then
     scrolling — a message longer than a line used to scroll out of sight inside
     a one-line box. */
  .compose textarea {
    flex: 1;
    resize: none;
    max-height: 8rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 12px;
    font: inherit;
    background: var(--bg-raised);
    color: var(--text);
  }
  .send {
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-contrast, #fff);
    cursor: pointer;
  }
  .send:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .send-error {
    margin: 0.25rem 0 0.5rem;
    font-size: 0.82rem;
    color: var(--danger);
  }
  .rejoin-note {
    margin: 0.4rem 0 0.5rem;
    font-size: 0.82rem;
  }
</style>
