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
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { copyText } from "$lib/util/clipboard.js";
  import { countQueuedForOwner } from "$lib/nostr/publish-queue.js";

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

  // Logout with an unsent-actions guard (audit U1). Logging out DISCARDS this
  // account's still-queued outbox items (a shared-device safety measure), so warn
  // first when any exist — otherwise a queued join/DM/follow would vanish silently.
  let confirmingLogout = $state(false);
  let unsentCount = $state(0);
  async function requestLogout() {
    unsentCount = session.pubkey
      ? await countQueuedForOwner(session.pubkey).catch(() => 0)
      : 0;
    if (unsentCount > 0) confirmingLogout = true;
    else void session.logout();
  }
  function confirmLogout() {
    confirmingLogout = false;
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
          <a class="btn" href={c.url} target="_blank" rel="noopener">{c.name} ↗</a>
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
    {#if confirmingLogout}
      <p role="alert">{t("me.logout.warnUnsent", { n: unsentCount })}</p>
      <div class="row" style="gap:0.5rem;flex-wrap:wrap">
        <button class="btn danger" onclick={confirmLogout}>{t("me.logout.confirmDiscard")}</button>
        <button class="btn" onclick={() => (confirmingLogout = false)}>{t("me.logout.cancel")}</button>
      </div>
    {:else}
      <button class="btn danger" onclick={requestLogout}>{t("me.logout")}</button>
    {/if}
  </div>
{/if}
