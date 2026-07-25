<script lang="ts">
  // Key backup (spec §5.2). The simple, primary action is "copy your secret key"
  // — one tap, paste it into any Nostr app as your private key. Email + NIP-49
  // are tucked under "More ways to back up" for people who want them.
  import { onDestroy, onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { toNsec, toNcryptsec, mailtoBackup } from "$lib/signer/backup.js";
  import { markBackedUp } from "$lib/stores/backup-nag.svelte.js";
  import { markKeyBackedUp } from "$lib/events/key-backup.js";
  import { advanceStage, isSecured, type BackupStage } from "$lib/stores/backup-stages.js";
  import { enterSecretSurface } from "$lib/stores/secret-surface.svelte.js";
  import { copyText } from "$lib/util/clipboard.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  // §13.3: this card reveals key material (nsec copy, ncryptsec, a mailto with
  // the key), so suppress any live event theme while it's mounted — Join/Create
  // render it on themed event routes.
  onMount(() => enterSecretSurface());

  // Truthful backup stages (UX-O7): copying/exporting reaches "copied" (visible,
  // not secured); an explicit "I saved it" confirmation publishes the durable
  // marker and reaches "confirmed" — the only stage the nag/readiness trusts.
  let stage = $state<BackupStage>("none");
  let confirming = $state(false);
  let confirmError = $state(false);

  async function confirmSaved() {
    stage = advanceStage(stage, "saved");
    confirming = true;
    confirmError = false;
    try {
      // The durable, relay-persisted marker IS the honest readiness signal — a
      // failed publish must NOT claim "backed up", so we await it and surface
      // failure (retryable) instead of firing-and-forgetting.
      if (session.signer) await markKeyBackedUp(session.signer);
      markBackedUp();
      stage = advanceStage(stage, "confirmed");
    } catch {
      confirmError = true; // stays "saved" — honest and retryable
    } finally {
      confirming = false;
    }
  }

  const sk = $derived(session.signer?.getSecretKey?.());
  const appBase = $derived(
    typeof window !== "undefined" ? window.location.origin + window.location.pathname : "",
  );

  let pw = $state("");
  let ncryptsec = $state<string | null>(null);
  let copied = $state<string | null>(null);
  // U15: reveal/select fallback for a failed copy of a SECRET. A user whose
  // browser blocks the clipboard (embedded webview, restrictive policy, http)
  // must still be able to SEE and select their key, or they'd be locked out of
  // ever backing it up. This surface already suppresses the event theme.
  let revealed = $state<string | null>(null);

  // App-10: never keep secret material at rest longer than needed. Clear the
  // passphrase and the encrypted blob when the card unmounts.
  function wipeSecrets() {
    pw = "";
    ncryptsec = null;
    revealed = null;
  }
  onDestroy(wipeSecrets);

  async function copy(text: string, label: string) {
    if ((await copyText(text)) === "copied") {
      copied = label;
      revealed = null;
      // Copying is "copied", NOT "secured" (UX-O7) — securing is the explicit
      // confirmation below.
      stage = advanceStage(stage, "copied");
      setTimeout(() => (copied = null), 2000);
    } else {
      // Couldn't copy — reveal the value so it can be selected by hand. Still
      // counts as "copied" stage progress so the user can confirm they saved it.
      copied = null;
      revealed = text;
      stage = advanceStage(stage, "copied");
    }
  }

  function exportNcryptsec() {
    if (!sk || !pw) return;
    ncryptsec = toNcryptsec(sk, pw);
    // The passphrase has done its job — drop it immediately (App-10).
    pw = "";
  }

  function downloadNcryptsec() {
    if (!ncryptsec) return;
    stage = advanceStage(stage, "copied");
    const blob = new Blob([ncryptsec], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nostrautica-key.ncryptsec";
    a.click();
    URL.revokeObjectURL(url);
  }

  // App-10: build the key-bearing mailto: only at click time and hand it
  // straight to navigation — never an eager `href` sitting in the DOM with the
  // secret in it (which CSS/extensions could read, and which lingers in markup).
  function emailBackup() {
    if (!sk) return;
    stage = advanceStage(stage, "copied");
    window.location.href = mailtoBackup(appBase, sk);
  }
</script>

{#if !sk}
  <p class="muted">
    {t("backup.noKey")}
  </p>
{:else}
  <button class="btn primary" aria-live="polite" onclick={() => copy(toNsec(sk), "key")}>
    {copied === "key" ? t("backup.copied") : t("backup.copyKey")}
  </button>
  {#if revealed}
    <!-- U15 reveal/select fallback: the clipboard was unavailable — select this. -->
    <p class="muted" role="status" style="margin:0.5rem 0 0.25rem">{t("common.copyFailed")}</p>
    <textarea class="mono" readonly rows="2" style="width:100%" onfocus={(e) => e.currentTarget.select()}
      >{revealed}</textarea>
  {/if}
  <p class="muted" style="margin-top:0.5rem">
    {t("backup.warning.a")} <strong>{t("backup.warning.keepSecret")}</strong>{t("backup.warning.b")}
  </p>

  <!-- Truthful stages (UX-O7): copied ≠ secured. Once the secret is copied or
       exported, ask for an explicit "I saved it somewhere safe", which publishes
       the durable marker and only then reports "Backup confirmed". -->
  {#if stage !== "none"}
    <div class="card" style="margin-top:0.5rem;background:var(--bg-elev2)">
      {#if isSecured(stage)}
        <span class="badge ok" role="status">{t("backup.stage.confirmed")}</span>
      {:else if stage === "saved"}
        {#if confirming}
          <span class="badge" role="status">{t("backup.stage.confirming")}</span>
        {:else}
          <span class="badge" role="status">{t("backup.stage.saved")}</span>
          {#if confirmError}
            <p class="muted" style="color:var(--danger);margin:0.25rem 0 0.5rem">{t("backup.stage.confirmFailed")}</p>
            <button class="btn inline" onclick={confirmSaved}>{t("backup.stage.retry")}</button>
          {/if}
        {/if}
      {:else}
        <!-- copied -->
        <p class="muted" role="status" style="margin:0 0 0.5rem">{t("backup.stage.copied")}</p>
        <button class="btn inline primary" onclick={confirmSaved} disabled={confirming}>
          {t("backup.stage.iSavedIt")}
        </button>
      {/if}
    </div>
  {/if}

  <details style="margin-top:0.5rem">
    <summary class="muted" style="cursor:pointer">{t("backup.more")}</summary>
    <div class="stack" style="margin-top:0.75rem">
      <div>
        <div class="field-label">{t("backup.email.title")}</div>
        <p class="muted">
          {t("backup.email.body")}
        </p>
        <button class="btn" type="button" onclick={emailBackup}>
          {t("backup.email.button")}
        </button>
      </div>
      <div>
        <div class="field-label">{t("backup.file.title")}</div>
        <input type="password" placeholder={t("backup.file.placeholder")} bind:value={pw} />
        <div class="row" style="margin-top:0.5rem">
          <button class="btn inline" onclick={exportNcryptsec} disabled={!pw}>{t("backup.file.encrypt")}</button>
          {#if ncryptsec}
            <button class="btn inline" onclick={downloadNcryptsec}>{t("backup.file.download")}</button>
            <button class="btn inline" onclick={() => copy(ncryptsec!, "file")}>{t("backup.file.copy")}</button>
          {/if}
        </div>
        {#if ncryptsec}<p class="mono">{ncryptsec}</p>{/if}
      </div>
    </div>
  </details>
{/if}
