<script lang="ts">
  // Key backup (spec §5.2). The simple, primary action is "copy your secret key"
  // — one tap, paste it into any Nostr app as your private key. Email + NIP-49
  // are tucked under "More ways to back up" for people who want them.
  import { onDestroy, onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { toNsec, toNcryptsec, mailtoBackup } from "$lib/signer/backup.js";
  import { markBackedUp } from "$lib/stores/backup-nag.svelte.js";
  import { markKeyBackedUp } from "$lib/events/key-backup.js";
  import { enterSecretSurface } from "$lib/stores/secret-surface.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  // §13.3: this card reveals key material (nsec copy, ncryptsec, a mailto with
  // the key), so suppress any live event theme while it's mounted — Join/Create
  // render it on themed event routes.
  onMount(() => enterSecretSurface());

  /** Record a durable, relay-persisted backup marker (honest readiness signal). */
  function markDurable() {
    if (session.signer) markKeyBackedUp(session.signer).catch(() => {});
  }

  const sk = $derived(session.signer?.getSecretKey?.());
  const appBase = $derived(
    typeof window !== "undefined" ? window.location.origin + window.location.pathname : "",
  );

  let pw = $state("");
  let ncryptsec = $state<string | null>(null);
  let copied = $state<string | null>(null);

  // App-10: never keep secret material at rest longer than needed. Clear the
  // passphrase and the encrypted blob when the card unmounts.
  function wipeSecrets() {
    pw = "";
    ncryptsec = null;
  }
  onDestroy(wipeSecrets);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      markBackedUp();
      markDurable();
      setTimeout(() => (copied = null), 2000);
    } catch {
      copied = null;
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
    markBackedUp();
    markDurable();
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
    markBackedUp();
    markDurable();
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
  <p class="muted" style="margin-top:0.5rem">
    {t("backup.warning.a")} <strong>{t("backup.warning.keepSecret")}</strong>{t("backup.warning.b")}
  </p>

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
