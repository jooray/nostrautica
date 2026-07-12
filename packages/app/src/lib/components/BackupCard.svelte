<script lang="ts">
  // Key backup card (spec §5.2). Only meaningful for local-key users — the ones
  // who hold their own secret. Offers: email-to-self (nsec in URL fragment),
  // NIP-49 export (password-encrypted), and raw nsec copy (with a warning).
  import { session } from "$lib/signer/session.svelte.js";
  import { toNsec, toNcryptsec, mailtoBackup } from "$lib/signer/backup.js";

  const sk = $derived(session.signer?.getSecretKey?.());
  const appBase = $derived(
    typeof window !== "undefined" ? window.location.origin + window.location.pathname : "",
  );

  let revealNsec = $state(false);
  let pw = $state("");
  let ncryptsec = $state<string | null>(null);
  let copied = $state<string | null>(null);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      setTimeout(() => (copied = null), 1500);
    } catch {
      copied = null;
    }
  }

  function exportNcryptsec() {
    if (!sk || !pw) return;
    ncryptsec = toNcryptsec(sk, pw);
  }

  function downloadNcryptsec() {
    if (!ncryptsec) return;
    const blob = new Blob([ncryptsec], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nostrautica-key.ncryptsec";
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

{#if !sk}
  <p class="muted">
    Your key lives in your signer — back it up there. Nothing to export here.
  </p>
{:else}
  <div class="stack">
    <div>
      <div class="field-label">1. Email it to yourself</div>
      <p class="muted">
        A one-tap recovery link. <strong>Email is not confidential transport</strong> —
        this trades a little privacy against losing access. The key rides the URL
        fragment and never reaches a server.
      </p>
      <a class="btn" href={mailtoBackup(appBase, sk)}>Email my recovery link</a>
    </div>

    <div>
      <div class="field-label">2. Password-protected file (NIP-49)</div>
      <input type="password" placeholder="Choose a passphrase" bind:value={pw} />
      <div class="row" style="margin-top:0.5rem">
        <button class="btn inline" onclick={exportNcryptsec} disabled={!pw}>
          Encrypt
        </button>
        {#if ncryptsec}
          <button class="btn inline" onclick={downloadNcryptsec}>Download</button>
          <button class="btn inline" onclick={() => copy(ncryptsec!, "ncryptsec")}>
            Copy
          </button>
        {/if}
      </div>
      {#if ncryptsec}<p class="mono">{ncryptsec}</p>{/if}
    </div>

    <div class="warn card">
      <div class="field-label">3. Raw key (advanced)</div>
      <p class="muted">
        Paste this nsec into Primal, Damus, Amethyst… Anyone who sees it controls
        your identity. Never share it.
      </p>
      {#if revealNsec}
        <p class="mono">{toNsec(sk)}</p>
        <button class="btn inline" onclick={() => copy(toNsec(sk), "nsec")}>Copy nsec</button>
      {:else}
        <button class="btn inline danger" onclick={() => (revealNsec = true)}>
          Reveal nsec
        </button>
      {/if}
    </div>

    {#if copied}<p class="muted">Copied {copied} ✓</p>{/if}
  </div>
{/if}
