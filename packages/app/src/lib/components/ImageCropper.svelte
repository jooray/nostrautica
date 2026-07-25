<script lang="ts">
  /**
   * Interactive crop/zoom picker (user feedback 2026-07-17: "add a picker to
   * crop/scale to the target aspect — we upload blind otherwise"). A fixed-aspect
   * viewport shows the image; drag to pan, slider to zoom. On confirm it renders
   * the visible region to a canvas at the exact output size, so what the user
   * frames is exactly what gets uploaded and rendered.
   */
  import { onMount, onDestroy } from "svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { focusTrap } from "./focus-trap.js";
  import { coverScale, centerOffset, clampOffset, panBy, cropRect } from "./crop-geometry.js";

  let {
    file,
    aspect, // width / height of the crop (e.g. 1 for icon, 2.5 for a 5:2 banner)
    outWidth,
    onConfirm,
    onCancel,
  }: {
    file: Blob;
    aspect: number;
    outWidth: number;
    onConfirm: (blob: Blob) => void;
    onCancel: () => void;
  } = $props();

  const VIEW_W = 300; // logical viewport width in px; height derives from aspect
  const viewH = $derived(VIEW_W / aspect);

  let bitmap = $state<ImageBitmap | undefined>(undefined);
  let ready = $state(false);
  let decodeError = $state(false);
  let zoom = $state(1); // 1 = image just covers the viewport
  let ox = $state(0); // image top-left x within the viewport (px)
  let oy = $state(0);
  let baseScale = 1; // "cover" scale at zoom=1
  let objectUrl = $state("");

  onMount(async () => {
    objectUrl = URL.createObjectURL(file);
    try {
      bitmap = await createImageBitmap(file);
      baseScale = coverScale(bitmap.width, bitmap.height, VIEW_W, viewH);
      center();
      ready = true;
    } catch {
      // Don't silently close (audit App-9): HEIC / corrupt / unsupported images
      // fail to decode here, and a disappearing dialog reads as a broken app.
      // Surface a visible reason and let the user dismiss it themselves.
      decodeError = true;
    }
  });
  onDestroy(() => {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  const dispW = $derived(bitmap ? bitmap.width * baseScale * zoom : 0);
  const dispH = $derived(bitmap ? bitmap.height * baseScale * zoom : 0);

  function center() {
    ({ ox, oy } = centerOffset(dispW, dispH, VIEW_W, viewH));
  }
  function clamp() {
    // The image must always cover the viewport (no empty edges).
    ({ ox, oy } = clampOffset(ox, oy, dispW, dispH, VIEW_W, viewH));
  }
  // Keyboard panning (audit §7.3.2): arrows nudge the crop for pointer-free use.
  function onViewportKey(e: KeyboardEvent) {
    const map: Record<string, "left" | "right" | "up" | "down"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const dir = map[e.key];
    if (!dir || !ready) return;
    e.preventDefault();
    ({ ox, oy } = panBy(dir, ox, oy, dispW, dispH, VIEW_W, viewH));
  }
  $effect(() => {
    void zoom; // re-clamp when zoom changes
    if (ready) clamp();
  });

  // Drag to pan.
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startOx = 0;
  let startOy = 0;
  function onPointerDown(e: PointerEvent) {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startOx = ox;
    startOy = oy;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    // Viewport is rendered at VIEW_W CSS px too (max-width guard below), so 1:1.
    ox = startOx + (e.clientX - startX);
    oy = startOy + (e.clientY - startY);
    clamp();
  }
  function onPointerUp() {
    dragging = false;
  }

  function confirm() {
    if (!bitmap) return;
    const outH = Math.round(outWidth / aspect);
    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outH;
    const c2d = canvas.getContext("2d");
    if (!c2d) return onCancel();
    // Map the viewport region back into image space.
    const { sx, sy, sw, sh } = cropRect(ox, oy, baseScale * zoom, VIEW_W, viewH);
    c2d.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outWidth, outH);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    canvas.toBlob((b) => (b ? onConfirm(b) : onCancel()), type, 0.9);
  }
</script>

<div
  class="backdrop"
  role="dialog"
  aria-modal="true"
  aria-label={t("cropper.title")}
  tabindex="-1"
  use:focusTrap
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }}
>
  <div class="sheet">
    <h2>{t("cropper.title")}</h2>
    {#if decodeError}
      <p class="error" role="alert">{t("cropper.decodeError")}</p>
      <div class="row actions">
        <button class="btn inline primary" onclick={onCancel}>{t("cropper.cancel")}</button>
      </div>
    {:else}
    <p class="muted hint">{t("cropper.hint")}</p>

    <!-- Custom pan/zoom crop surface: focusable and fully keyboard-operable (arrow keys
         pan via onViewportKey, mirroring pointer drag) with an aria-label. role="group"
         is non-interactive per ARIA, so these fire as false positives on an intentionally
         interactive widget that is already accessible. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="viewport"
      role="group"
      aria-label={t("cropper.viewportLabel")}
      tabindex="0"
      style="width:{VIEW_W}px;height:{viewH}px"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onkeydown={onViewportKey}
    >
      {#if objectUrl}
        <img
          src={objectUrl}
          alt=""
          draggable="false"
          style="left:{ox}px;top:{oy}px;width:{dispW}px;height:{dispH}px"
        />
      {/if}
    </div>

    <label class="zoom">
      {t("cropper.zoom")}
      <input type="range" min="1" max="4" step="0.01" bind:value={zoom} disabled={!ready} />
    </label>

    <div class="row actions">
      <button class="btn inline" onclick={onCancel}>{t("cropper.cancel")}</button>
      <button class="btn inline primary" onclick={confirm} disabled={!ready}>
        {t("cropper.use")}
      </button>
    </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .sheet {
    background: var(--bg-elev, var(--bg));
    border: 1px solid var(--card-border, var(--border));
    border-radius: var(--radius, 14px);
    padding: 1.1rem;
    max-width: calc(100vw - 2rem);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    align-items: center;
  }
  .sheet h2 {
    margin: 0;
    align-self: flex-start;
  }
  .hint {
    margin: 0;
    align-self: flex-start;
    font-size: 0.85rem;
  }
  .error {
    margin: 0;
    align-self: flex-start;
    font-size: 0.9rem;
    color: var(--danger);
  }
  .viewport {
    position: relative;
    overflow: hidden;
    border-radius: 10px;
    background: var(--bg-elev2, #222);
    touch-action: none;
    cursor: grab;
    max-width: 100%;
  }
  .viewport:active {
    cursor: grabbing;
  }
  .viewport img {
    position: absolute;
    user-select: none;
    -webkit-user-drag: none;
    max-width: none;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .zoom input {
    flex: 1;
  }
  .actions {
    align-self: stretch;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
