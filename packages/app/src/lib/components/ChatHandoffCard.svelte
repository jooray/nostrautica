<script lang="ts">
  // "Chat devices" status card (NIP §10 multi-device).
  //
  // v1 offered a free-text "authorize an existing npub" flow: paste any pubkey and
  // the app would 21607-attest it. Wire v2 requires a proof of possession on every
  // add (attest.ts / NIP §10.2), which the app can't produce for a key it doesn't
  // hold — and that free-text flow was exactly the griefing/mis-binding vector the
  // proof closes (attest a key you don't control). So it's removed.
  //
  // Under per-device keys the correct model is simply: each device mints and attests
  // its own chat key when it opens the event, and joins the group on its own. There
  // is nothing to paste. This card is now an informational status; full device
  // management (list/label/revoke own devices) is Phase 3.
  import { t } from "$lib/i18n/i18n.svelte.js";
</script>

<section class="handoff card">
  <strong>{t("chat.devices.title")}</strong>
  <p class="muted">{t("chat.devices.body")}</p>
</section>

<style>
  .handoff {
    margin-top: 1.25rem;
  }
</style>
