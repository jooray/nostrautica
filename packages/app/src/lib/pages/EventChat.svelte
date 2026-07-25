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
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    loadEventContext,
    cachedEventContext,
    type EventContext,
  } from "$lib/events/event-context.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import { receiveGrants, fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import { buildDeviceAccountMap, chatMembers } from "$lib/chat/members.js";
  import type { RosterContent } from "@nostrautica/protocol";
  import { evaluateChatGate } from "$lib/chat/gate.js";
  import { chatSession } from "$lib/chat/session.svelte.js";
  import { fillHeight } from "$lib/components/fill-height.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { avatarHues } from "$lib/identity/avatar.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ChatHandoffCard from "$lib/components/ChatHandoffCard.svelte";
  import type { ChatMessage } from "$lib/chat/messages.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { saveDraft, loadDraft } from "$lib/stores/drafts.js";

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
  const members = $derived(chatMembers(roster));
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

  const phase = $derived.by<"loading" | "setup" | "ready" | "unavailable">(() => {
    if (error || chatSession.error) return "unavailable";
    if (gate === "loading") return "loading";
    if (gate === "unavailable") return "unavailable";
    return chatSession.phase === "ready" ? "ready" : "setup";
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

  async function send() {
    const text = draft.trim();
    // A leader has its own client; an interactive follower proxies through the
    // leader tab (chatSession.send). Only a read-only follower can't send.
    if (!text || sending || readOnly) return;
    sending = true;
    sendError = null;
    try {
      await chatSession.send(text);
      draft = "";
    } catch {
      // Bug 5: surface the failure instead of silently swallowing it. A revoked
      // (removed) attendee's send lands here once they've lost the group locally.
      sendError = t("chat.sendFailed");
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
      <summary>{t("chat.members.title")} · {members.length}</summary>
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
          {#if setupSlow}
            <p class="muted" style="margin-top:0.5rem">{t("chat.setupSlow")}</p>
            <button class="btn inline" style="margin-top:0.25rem" onclick={retryChat}>
              {t("chat.retry")}
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
              <span class="irc-nick" style="--nick-h:{nickHue(m.pubkey)}">&lt;{nameOf(m.pubkey)}&gt;</span>
              <span class="irc-text">{m.content}</span>
            </p>
          {:else}
            {@const showSender = i === 0 || g.items[i - 1]!.pubkey !== m.pubkey}
            <div class="msg" class:mine>
              {#if showSender}
                <Avatar
                  pubkey={accountOf(m.pubkey)}
                  name={nameOf(m.pubkey)}
                  picture={pictureOf(m.pubkey)}
                  size={26}
                />
              {:else}
                <span class="avatar-spacer" aria-hidden="true"></span>
              {/if}
              <div class="col">
                {#if showSender}<span class="sender">{nameOf(m.pubkey)}</span>{/if}
                <div class="bubble">
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
      <textarea
        bind:value={draft}
        rows="1"
        placeholder={t("chat.compose.placeholder")}
        disabled={phase === "setup"}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      ></textarea>
      <button class="send" type="submit" disabled={!draft.trim() || sending || phase === "setup"} aria-label={t("chat.send")}>
        <Icon name="send" size={20} />
      </button>
    </form>
  {/if}

  {#if sendError}
    <p class="send-error" role="alert">{sendError}</p>
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
  .compose {
    position: sticky;
    bottom: 0;
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    padding: 0.5rem 0;
    background: var(--bg);
  }
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
</style>
