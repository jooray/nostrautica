<script lang="ts">
  // Render one monochrome registry icon (redesign §3.3). Decorative by default
  // (aria-hidden); pass `label` to give it an accessible name (role="img").
  // The `{@html}` is safe: ICONS is a static local constant, never user input.
  import { ICONS, type IconName } from "./paths.js";

  let {
    name,
    size = 24,
    label,
  }: { name: IconName; size?: number; label?: string } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.9"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
>
  {@html ICONS[name]}
</svg>
