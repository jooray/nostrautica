<script lang="ts" module>
  /**
   * What logging out actually costs this identity, worst consequence first.
   *
   * `session.logout()` calls `clearKeystore()`, which `del()`s the raw secret
   * key. For an identity the APP generated, that is the only copy in existence
   * unless the person has already saved it somewhere — so for the majority
   * persona (a newcomer who tapped "create my identity" at an event and never
   * opened the backup card) one tap on a red button was permanent, silent
   * account loss. The old guard only asked for confirmation when the outbox
   * happened to be non-empty, i.e. it protected a queued DM but not the key.
   *
   * "Backed up" is `backupNag.done` — the same self-reported, owner-scoped
   * marker Home.svelte's backup nudge reads, set by BackupCard's explicit
   * "I saved it somewhere safe". Pure so the precedence is unit-testable.
   */
  export type LogoutRisk = "none" | "unsent" | "keyLoss";
  export function logoutRisk(o: {
    /** The key is held by THIS app (method "local"), not by an external signer. */
    localKey: boolean;
    /** The user has confirmed they saved it somewhere safe. */
    backedUp: boolean;
    unsentCount: number;
  }): LogoutRisk {
    // Key loss outranks unsent items: losing a queued follow is annoying, losing
    // the only copy of the key is unrecoverable. The key-loss panel still names
    // the unsent items too, so nothing is hidden by the ordering.
    if (o.localKey && !o.backedUp) return "keyLoss";
    return o.unsentCount > 0 ? "unsent" : "none";
  }
</script>

<script lang="ts">
  // The hand-off moment (spec §5.4 item 4): "Your Nostr profile is ready."
  // The full "You're a Nostr user now" payoff is ONLY for keys we just created —
  // veterans who signed in with their own identity (nip07/nip46/imported key) get
  // a compact profile page instead (REMOTE-SIGNER-TEST P4). The keystore doesn't
  // record generated-vs-imported, so a returning local-key user gets the middle
  // ground: backup card kept, onboarding pitch dropped.
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";
  import { copyText } from "$lib/util/clipboard.js";
  import { countQueuedForOwner } from "$lib/nostr/publish-queue.js";
  import { backupNag } from "$lib/stores/backup-nag.svelte.js";

  const clients = [
    { name: "Primal", url: "https://primal.net" },
    { name: "Damus", url: "https://damus.io" },
    { name: "Amethyst", url: "https://github.com/vitorpamplona/amethyst" },
    { name: "Yakihonne", url: "https://yakihonne.com" },
  ];

  const isLocal = $derived(session.signer?.method === "local");
  const showOnboarding = $derived(session.freshLocalKey);

  let copied = $state(false);
  async function copyNpub() {
    if (!session.npub) return;
    // U15: centralized copy with fallback; npub is public + shown on screen.
    if ((await copyText(session.npub)) === "copied") {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    }
  }

  // Logout guard (audit U1 + the key-loss hole it left open — see logoutRisk
  // above). Logging out DISCARDS this account's still-queued outbox items AND
  // deletes an app-held secret key, so ask first whenever either is true, naming
  // whichever consequence is worse in plain words.
  let logoutStage = $state<LogoutRisk>("none");
  let unsentCount = $state(0);
  async function requestLogout() {
    unsentCount = session.pubkey
      ? await countQueuedForOwner(session.pubkey).catch(() => 0)
      : 0;
    const risk = logoutRisk({
      localKey: session.signer?.method === "local",
      backedUp: backupNag.done,
      unsentCount,
    });
    if (risk === "none") void session.logout();
    else logoutStage = risk;
  }
  function confirmLogout() {
    logoutStage = "none";
    void session.logout();
  }
</script>

{#if !session.loggedIn}
  <div class="card">
    <p>{t("me.notLoggedIn")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("me.login")}</button>
  </div>
{:else}
  <h1 style="display:flex;align-items:center;gap:0.5rem">
    <span style="color:var(--accent)"><NostrichIcon size={30} /></span>
    {showOnboarding ? t("me.title.new") : t("me.title.profile")}
  </h1>
  {#if showOnboarding}
    <p>
      {t("me.new.body")}
    </p>
  {/if}

  <div class="card">
    <div class="field-label">{t("me.handle")}</div>
    <p class="muted" style="margin:0 0 0.25rem">
      {t("me.handle.body")}
    </p>
    <p class="mono">{session.npub}</p>
    <button class="btn inline" aria-live="polite" onclick={copyNpub}>{copied ? t("me.copied") : t("me.copyNpub")}</button>
    <p class="muted" style="margin-top:0.5rem">
      {t("me.signedInVia", { method: session.signer?.method ?? "" })}
      {#if !isLocal}
        {t("me.keyInSigner")}
      {/if}
    </p>
  </div>

  {#if showOnboarding}
    <div class="card">
      <h2>{t("me.takeAnywhere")}</h2>
      <p class="muted">
        {t("me.takeAnywhere.body")}
      </p>
      <BackupCard />
      <div class="stack" style="margin-top:0.75rem">
        {#each clients as c (c.name)}
          <a class="btn" href={c.url} target="_blank" rel="noopener noreferrer">{c.name} ↗</a>
        {/each}
      </div>
    </div>
  {:else if isLocal}
    <!-- Returning / imported local key: keep the backup affordance, skip the pitch. -->
    <div class="card">
      <h2>{t("me.backupKey")}</h2>
      <BackupCard />
    </div>
  {/if}

  <div class="card">
    {#if logoutStage === "keyLoss"}
      <!-- The unrecoverable branch. Everything here exists because the button
           below deletes the only copy of a key this app made: the consequence is
           spelled out (no "are you sure?"), the way OUT of the situation (the
           same BackupCard the rest of the app uses) is offered first and is the
           visually primary action, and the destructive button is worded as what
           it does rather than as "Log out". -->
      <!-- role="alert" on the WRAPPER, not on the <h2>: putting it on the heading
           would replace the heading role rather than add to it, and the whole
           paragraph — not just its title — is what has to be heard. -->
      <div role="alert">
        <h2>{t("me.logout.keyLoss.title")}</h2>
        <p>{t("me.logout.keyLoss.body")}</p>
        {#if unsentCount > 0}
          <!-- Both consequences apply; ordering picked the headline, not the facts. -->
          <p class="muted">{tp("me.logout.warnUnsent", unsentCount)}</p>
        {/if}
      </div>
      <div class="card" style="background:var(--bg-elev2)">
        <div class="field-label" style="margin-top:0">{t("me.logout.keyLoss.backup")}</div>
        <BackupCard />
      </div>
      <div class="row" style="gap:0.5rem;flex-wrap:wrap">
        <button class="btn" onclick={() => (logoutStage = "none")}>{t("me.logout.cancel")}</button>
        <button class="btn danger" onclick={confirmLogout}>{t("me.logout.keyLoss.confirm")}</button>
      </div>
    {:else if logoutStage === "unsent"}
      <p role="alert">{tp("me.logout.warnUnsent", unsentCount)}</p>
      <div class="row" style="gap:0.5rem;flex-wrap:wrap">
        <button class="btn danger" onclick={confirmLogout}>{t("me.logout.confirmDiscard")}</button>
        <button class="btn" onclick={() => (logoutStage = "none")}>{t("me.logout.cancel")}</button>
      </div>
    {:else}
      <button class="btn danger" onclick={requestLogout}>{t("me.logout")}</button>
    {/if}
  </div>
{/if}
