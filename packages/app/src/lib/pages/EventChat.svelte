<script lang="ts">
  // Marmot group chat (MARMOT-GROUP-CHAT §7). Members-only, gated by
  // eventShell.showChat (chat=marmot + coordinator). The whole marmot-ts stack is
  // lazy-loaded here so chat-off events never pay for it. Alpha/experimental.
  import { onMount, onDestroy } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    loadEventContext,
    cachedEventContext,
    type EventContext,
  } from "$lib/events/event-context.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import { receiveGrants } from "$lib/events/attendee.js";
  import { evaluateChatGate } from "$lib/chat/gate.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { avatarHues } from "$lib/identity/avatar.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ChatHandoffCard from "$lib/components/ChatHandoffCard.svelte";
  import type { ChatMessage } from "$lib/chat/messages.js";
  import type { MarmotChat } from "$lib/chat/client.js";

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

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let phase = $state<"loading" | "setup" | "ready" | "unavailable">("loading");
  let error = $state<unknown>(null);
  let sendError = $state<string | null>(null);
  let messages = $state<ChatMessage[]>([]);
  let draft = $state("");
  let sending = $state(false);
  // Set once our own membership-resolve pass (grant fetch + shell re-sync) has run.
  let membershipKnown = $state(false);
  // Latches once we've kicked off the chat session — prevents the reactive gate
  // from starting it twice. Plain (non-reactive) on purpose.
  let started = false;
  // $state.raw: reactive by reference (so the handoff card appears once set)
  // without deep-proxying the class instance.
  let chat = $state.raw<MarmotChat | undefined>(undefined);
  let chatPubkey = $state<string | undefined>(undefined);
  // Setup usually completes within seconds (member publishes key package →
  // coordinator adds them → welcome lands). If it's still spinning after a grace
  // period the coordinator may be slow/asleep or a socket dropped — surface a
  // gentle hint + a Try again that re-runs the handshake (no page reload).
  let setupSlow = $state(false);
  // Sender kind-0s (name/picture), keyed by chat-identity pubkey — filled in
  // reactively as new senders show up in `messages`.
  let profiles = $state<Map<string, ProfileMeta>>(new Map());
  let displayMode = $state<DisplayMode>(loadDisplayMode());

  function setDisplayMode(mode: DisplayMode): void {
    displayMode = mode;
    try {
      localStorage.setItem(DISPLAY_MODE_KEY, mode);
    } catch {
      /* storage unavailable — preference stays in-memory only */
    }
  }

  onMount(async () => {
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
    } catch (e) {
      error = e;
    } finally {
      // Membership is now genuinely known (member or not) — release the gate.
      membershipKnown = true;
    }
  });

  onDestroy(() => chat?.dispose());

  // Reactive membership gate (Bug 3). Re-evaluates whenever the event-shell's
  // roster/ECK/membership state resolves, so a late-resolving Add transitions the
  // page from "loading" into setup/ready instead of stranding on the negative.
  // The gate can only settle "unavailable" once membership is genuinely known.
  $effect(() => {
    if (started || error) return;
    const gate = evaluateChatGate({
      membershipKnown,
      shellNaddr: eventShell.naddr,
      naddr,
      loading: eventShell.loading,
      showChat: eventShell.showChat,
      hasSigner: !!session.signer,
    });
    if (gate === "loading") {
      phase = "loading";
    } else if (gate === "unavailable") {
      phase = "unavailable";
    } else {
      // Member + chat enabled: start the session exactly once.
      started = true;
      void startChat();
    }
  });

  // Lazy-load the whole marmot stack and drive the member side of the protocol.
  async function startChat() {
    if (!ctx || !session.signer) {
      phase = "unavailable";
      return;
    }
    try {
      phase = "setup";
      const { MarmotChat } = await import("$lib/chat/client.js");
      chat = await MarmotChat.create({ accountSigner: session.signer, ctx });
      chatPubkey = chat.identity.pubkey;
      chat.onMessage = (m) => {
        // De-dupe by inner rumor id; keep chronological order. This also absorbs
        // any echo of our own optimistically-appended message (Bug 4).
        if (messages.some((x) => x.id === m.id)) return;
        messages = [...messages, m].sort((a, b) => a.createdAt - b.createdAt);
      };
      // The coordinator adds us (and delivers the welcome) after we publish our key
      // package, so the join usually lands seconds after start(). React to it: when
      // a group appears we leave "setup" and enable composing. Without this the view
      // stays on "Setting up your secure chat…" forever even once joined (gap G-3).
      chat.onStateChange = () => {
        if (phase === "setup") void syncPhase();
      };
      await chat.ensurePublished();
      await chat.start();
      // If a welcome hasn't arrived yet the group list is empty — stay in "setup"
      // messaging until the coordinator adds us and the first welcome lands (then
      // onStateChange flips us to "ready").
      await syncPhase();
    } catch (e) {
      error = e;
      phase = "unavailable";
    }
  }

  // Flip to "ready" once we've joined a group (a nostr_group_id exists).
  async function syncPhase() {
    if (!chat) return;
    const gid = await chat.nostrGroupId();
    if (gid) phase = "ready";
  }

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
    chat?.dispose();
    chat = undefined;
    chatPubkey = undefined;
    await startChat();
  }

  async function send() {
    const text = draft.trim();
    if (!text || !chat || sending) return;
    sending = true;
    sendError = null;
    try {
      await chat.send(text);
      draft = "";
    } catch {
      // Bug 5: surface the failure instead of silently swallowing it. A revoked
      // (removed) attendee's send lands here once they've lost the group locally.
      sendError = t("chat.sendFailed");
    } finally {
      sending = false;
    }
  }

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
    const missing = [...new Set(messages.map((m) => m.pubkey))].filter(
      (pk) => !fetchedProfileFor.has(pk),
    );
    if (missing.length === 0) return;
    for (const pk of missing) fetchedProfileFor.add(pk);
    const cached = cachedProfiles(missing);
    if (cached.size) profiles = new Map([...profiles, ...cached]);
    void fetchProfiles(missing).then((fresh) => {
      if (fresh.size) profiles = new Map([...profiles, ...fresh]);
    });
  });

  function nameOf(pubkey: string): string {
    return profiles.get(pubkey)?.name?.trim() || pubkey.slice(0, 8);
  }
  // Deterministic per-sender hue (shared with Avatar's gradient) for the IRC
  // nick colour — same person always renders the same colour everywhere.
  function nickHue(pubkey: string): string {
    return avatarHues(pubkey)[0].toFixed(0);
  }
</script>

<div class="chat-head">
  <h1 class="disp">{t("chat.title")}</h1>
  <span class="badge">{t("chat.experimental")}</span>
</div>

<!-- Coordinator-read + from-join-epoch disclosure (§4.5). Always shown. -->
<div class="disclosure" role="note">
  <Icon name="info" size={18} />
  <p>{t("chat.disclosure.body")}</p>
</div>

{#if phase === "unavailable"}
  {#if error}
    <ErrorState {error} />
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

  <div class="messages" class:irc={displayMode === "irc"} aria-live="polite">
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
            {@const showSender = !mine && (i === 0 || g.items[i - 1]!.pubkey !== m.pubkey)}
            <div class="msg" class:mine>
              {#if !mine}
                {#if showSender}
                  <Avatar
                    pubkey={m.pubkey}
                    name={profiles.get(m.pubkey)?.name}
                    picture={profiles.get(m.pubkey)?.picture}
                    size={26}
                  />
                {:else}
                  <span class="avatar-spacer" aria-hidden="true"></span>
                {/if}
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

  <form class="compose" onsubmit={(e) => { e.preventDefault(); void send(); }}>
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

  {#if sendError}
    <p class="send-error" role="alert">{sendError}</p>
  {/if}

  {#if chat}
    <ChatHandoffCard isAccountKey={chat.identity.isAccountKey} secretKey={chat.identity.secretKey} />
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
  .messages {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-height: 40vh;
    padding-bottom: 0.5rem;
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
    gap: 0.45rem;
    align-items: flex-end;
    justify-content: flex-start;
  }
  .msg.mine {
    justify-content: flex-end;
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
    margin: 0 0 0.15rem 0.2rem;
  }
  .bubble {
    padding: 0.45rem 0.65rem;
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
    font-size: 0.68rem;
    color: var(--text-dim);
    margin-top: 0.15rem;
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
