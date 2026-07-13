<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { publishProfile, ensureRelayList } from "$lib/events/nostr-actions.js";
  import { uploadPublicImage } from "$lib/media/image.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import SignInOptions from "$lib/components/SignInOptions.svelte";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let showExisting = $state(false);
  let newName = $state("");
  let picFile = $state<File | null>(null);
  let picPreview = $state("");

  function onPicFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (picPreview) URL.revokeObjectURL(picPreview);
    picFile = f;
    picPreview = URL.createObjectURL(f);
  }

  const createNew = () => {
    error = null;
    busy = true;
    (async () => {
      try {
        await session.createLocalKey();
        const signer = session.signer;
        if (signer) {
          let picture: string | undefined;
          if (picFile) picture = await uploadPublicImage(signer, picFile).catch(() => undefined);
          if (newName.trim() || picture) {
            await publishProfile(signer, { name: newName.trim() || undefined, picture }).catch(() => {});
          }
          await ensureRelayList(signer).catch(() => {});
        }
        // Stay so the freshly-generated key's backup card shows.
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        busy = false;
      }
    })();
  };

  function done() {
    router.go({ name: "home" });
  }
</script>

{#if session.loggedIn && session.freshLocalKey}
  <h1>You're in 🎉</h1>
  <div class="card">
    <p class="muted">
      A Nostr identity was just created for you. Back it up now so you never lose
      access.
    </p>
    <BackupCard />
    <button class="btn primary" onclick={done} style="margin-top:0.75rem">Continue</button>
  </div>
{:else if session.loggedIn}
  <div class="card">
    <p>You're already logged in.</p>
    <button class="btn primary" onclick={done}>Continue</button>
  </div>
{:else}
  <h1>Welcome</h1>

  {#if error}
    <div class="card warn"><strong>Couldn't log in.</strong> {error}</div>
  {/if}

  <!-- Newcomers are the majority: identity creation is the primary path;
       existing-Nostr-user sign-in is a quiet option below (UI-SUGGESTIONS #1). -->
  <div class="card">
    <h2>Create your identity</h2>
    <p class="muted">No email, no password — your account is created instantly.</p>
    <div class="row" style="gap:0.75rem;align-items:center;margin-bottom:0.5rem">
      <label style="cursor:pointer;flex:none;margin:0">
        {#if picPreview}
          <img src={picPreview} alt="" width="64" height="64" style="border-radius:50%;object-fit:cover" />
        {:else}
          <span style="display:flex;width:64px;height:64px;border-radius:50%;border:1px dashed var(--border);align-items:center;justify-content:center;font-size:1.4rem;color:var(--text-dim)">＋</span>
        {/if}
        <input type="file" accept="image/*" onchange={onPicFile} style="display:none" />
      </label>
      <div class="muted" style="font-size:0.85rem">Photo <span class="badge">public</span><br />tap to add</div>
    </div>
    <label for="nm">Your name</label>
    <input id="nm" bind:value={newName} placeholder="How should people know you?" />
    <button class="btn primary" style="margin-top:0.75rem" onclick={createNew} disabled={busy}>
      {busy ? "Creating…" : "Create my identity"}
    </button>
  </div>

  <div class="or-divider">or</div>

  <button class="btn" onclick={() => (showExisting = !showExisting)}>
    <NostrichIcon size={20} />
    Already on Nostr? Sign in
  </button>

  {#if showExisting}
    <SignInOptions onSignedIn={done} />
  {/if}
{/if}
