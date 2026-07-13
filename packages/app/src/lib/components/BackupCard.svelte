<script lang="ts">
  // Key backup (spec §5.2). The simple, primary action is "copy your secret key"
  // — one tap, paste it into any Nostr app as your private key. Email + NIP-49
  // are tucked under "More ways to back up" for people who want them.
  import { session } from "$lib/signer/session.svelte.js";
  import { toNsec, toNcryptsec, mailtoBackup } from "$lib/signer/backup.js";
  import { markBackedUp } from "$lib/stores/backup-nag.svelte.js";

  const sk = $derived(session.signer?.getSecretKey?.());
  const appBase = $derived(
    typeof window !== "undefined" ? window.location.origin + window.location.pathname : "",
  );

  let pw = $state("");
  let ncryptsec = $state<string | null>(null);
  let copied = $state<string | null>(null);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      markBackedUp();
      setTimeout(() => (copied = null), 2000);
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
    markBackedUp();
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
  <button class="btn primary" onclick={() => copy(toNsec(sk), "key")}>
    {copied === "key" ? "Copied ✓ — now paste it into a Nostr app" : "📋 Copy my secret key"}
  </button>
  <p class="muted" style="margin-top:0.5rem">
    This is your private key. It's like your password — <strong>keep it secret</strong>,
    anyone who has it controls your account. To use another Nostr app, choose
    “log in with a key / nsec” there and paste this in.
  </p>

  <details style="margin-top:0.5rem">
    <summary class="muted" style="cursor:pointer">More ways to back up</summary>
    <div class="stack" style="margin-top:0.75rem">
      <div>
        <div class="field-label">Email a recovery link to yourself</div>
        <p class="muted">
          A one-tap link to get back in on any device. Note: email isn't fully
          private, so this trades a little privacy for convenience.
        </p>
        <a class="btn" href={mailtoBackup(appBase, sk)} onclick={() => markBackedUp()}>
          Email my recovery link
        </a>
      </div>
      <div>
        <div class="field-label">Password-protected file</div>
        <input type="password" placeholder="Choose a passphrase" bind:value={pw} />
        <div class="row" style="margin-top:0.5rem">
          <button class="btn inline" onclick={exportNcryptsec} disabled={!pw}>Encrypt</button>
          {#if ncryptsec}
            <button class="btn inline" onclick={downloadNcryptsec}>Download</button>
            <button class="btn inline" onclick={() => copy(ncryptsec!, "file")}>Copy</button>
          {/if}
        </div>
        {#if ncryptsec}<p class="mono">{ncryptsec}</p>{/if}
      </div>
    </div>
  </details>
{/if}
