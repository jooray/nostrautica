<script lang="ts">
  let { size = 22 }: { size?: number } = $props();
</script>

<!-- The Nostr "nostrich" (ostrich), a simple silhouette in currentColor. -->
<svg
  width={size}
  height={size}
  viewBox="0 0 40 44"
  fill="currentColor"
  aria-hidden="true"
  style="flex:none"
>
  <path d="M15 33 l-1.5 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
  <path d="M20 33 l1.5 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
  <ellipse cx="16" cy="27" rx="11" ry="8" />
  <path d="M24 23 C 30 19, 30 10, 28 6" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" />
  <circle cx="28" cy="5" r="3.6" />
  <path d="M31 4 l6 1.6 -6 2.2 z" />
</svg>
