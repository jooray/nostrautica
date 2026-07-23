<script lang="ts">
  /**
   * Wrap any secret-bearing UI (§13.3): while this is mounted the event theme is
   * suppressed, so no organizer CSS is live in a document holding a secret. Use
   * around invite nsec/QR output, key backups, chat device management, etc.
   *
   *   <SecretSurface>{ …secret markup… }</SecretSurface>
   */
  import { onMount } from "svelte";
  import { enterSecretSurface } from "$lib/stores/secret-surface.svelte.js";

  let { children } = $props();

  // onMount runs after the DOM is inserted but before the browser paints, and
  // enterSecretSurface() strips the stylesheet synchronously — so the wrapped
  // secret never paints a frame with event CSS live. The returned exit fn is the
  // unmount cleanup.
  onMount(() => enterSecretSurface());
</script>

{@render children?.()}
