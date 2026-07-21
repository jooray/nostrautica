<script lang="ts">
  // A person's avatar: their photo in a circle when present, otherwise a
  // deterministic gradient + initials so no row ever shows an empty grey circle
  // (redesign §3.4). The image is decorative (alt="") — the accessible name
  // always comes from the surrounding row/card text.
  import { npubEncode } from "nostr-tools/nip19";
  import { avatarGradient, initialsFor } from "$lib/identity/avatar.js";

  let {
    pubkey,
    name,
    picture,
    size = 40,
  }: { pubkey: string; name?: string; picture?: string; size?: number } = $props();

  let broken = $state(false);
  // Reset the error state if the picture URL changes.
  $effect(() => {
    void picture;
    broken = false;
  });

  const gradient = $derived(avatarGradient(pubkey));
  const npub = $derived.by(() => {
    try {
      return npubEncode(pubkey);
    } catch {
      return undefined;
    }
  });
  const initials = $derived(initialsFor(name, npub));
  const showImage = $derived(!!picture && !broken);
</script>

<span
  class="avatar"
  style="--sz:{size}px; {showImage ? '' : `background:${gradient}`}"
  aria-hidden="true"
>
  {#if showImage}
    <!-- lazy + async: a long roster must not eagerly fetch/decode every photo
         (audit APPR-3 perf) -->
    <img src={picture} alt="" loading="lazy" decoding="async" onerror={() => (broken = true)} />
  {:else}
    <span class="initials">{initials}</span>
  {/if}
</span>

<style>
  .avatar {
    width: var(--sz);
    height: var(--sz);
    border-radius: 50%;
    flex: none;
    display: grid;
    place-items: center;
    overflow: hidden;
    color: #fff;
    font-weight: 650;
    font-size: calc(var(--sz) * 0.4);
    letter-spacing: 0.01em;
    line-height: 1;
    user-select: none;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
