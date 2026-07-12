<script lang="ts">
  import QRCode from "qrcode";

  let { data, size = 220 }: { data: string; size?: number } = $props();
  let dataUrl = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    let cancelled = false;
    QRCode.toDataURL(data, { width: size, margin: 1 })
      .then((url) => {
        if (!cancelled) dataUrl = url;
      })
      .catch((e) => {
        if (!cancelled) error = String(e);
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if dataUrl}
  <img src={dataUrl} alt="QR code" width={size} height={size} style="border-radius:8px" />
{:else if error}
  <p class="muted">Could not render QR: {error}</p>
{:else}
  <p class="muted">Generating QR…</p>
{/if}
