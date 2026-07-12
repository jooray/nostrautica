<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { publishProfile, ensureRelayList } from "$lib/events/nostr-actions.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import SignInOptions from "$lib/components/SignInOptions.svelte";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let showExisting = $state(false);
  let newName = $state("");

  const createNew = () => {
    error = null;
    busy = true;
    (async () => {
      try {
        await session.createLocalKey();
        if (newName.trim() && session.signer) {
          await publishProfile(session.signer, { name: newName.trim() }).catch(() => {});
          await ensureRelayList(session.signer).catch(() => {});
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

  <button
    class="btn primary"
    style="padding:0.9rem;font-size:1.05rem"
    onclick={() => (showExisting = !showExisting)}
  >
    <NostrichIcon size={24} />
    I'm already a Nostr user
  </button>

  {#if showExisting}
    <SignInOptions onSignedIn={done} />
  {/if}

  <div class="or-divider">or</div>

  <div class="card">
    <h2>Create your identity</h2>
    <p class="muted">
      New to this? No problem — we'll set up a Nostr account for you. No password,
      no jargon.
    </p>
    <label for="nm">Your name</label>
    <input id="nm" bind:value={newName} placeholder="How should people know you?" />
    <button class="btn primary" style="margin-top:0.75rem" onclick={createNew} disabled={busy}>
      {busy ? "Creating…" : "Create my identity"}
    </button>
  </div>
{/if}
