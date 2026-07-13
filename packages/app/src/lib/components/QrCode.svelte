<script lang="ts">
  import QRCode from "qrcode";
  import { t } from "$lib/i18n/i18n.svelte.js";

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
  <img src={dataUrl} alt={t("qr.alt")} width={size} height={size} style="border-radius:8px" />
{:else if error}
  <p class="muted">{t("qr.error", { reason: error })}</p>
{:else}
  <p class="muted">{t("qr.generating")}</p>
{/if}
