<script lang="ts">
  // Printable invite sheet (spec §13 organizer QoL): a full-screen overlay that
  // renders each unused invite code as a QR of its join URL + label, laid out N
  // per page for printing/cutting up. §13.3: invite codes embed single-use nsecs
  // and their QRs, so this is a sensitive surface — suppress the event theme while
  // it's shown, exactly like the invite links in Admin.
  import { onMount } from "svelte";
  import QrCode from "$lib/components/QrCode.svelte";
  import { focusTrap } from "./focus-trap.js";
  import { enterSecretSurface } from "$lib/stores/secret-surface.svelte.js";
  import { invitesForSheet } from "$lib/events/invite-sheet.js";
  import type { GeneratedInvite } from "$lib/events/organizer.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    invites,
    eventTitle,
    onClose,
  }: { invites: GeneratedInvite[]; eventTitle: string; onClose: () => void } = $props();

  onMount(() => enterSecretSurface());

  // No client-side redemption tracking yet, so every generated code is unused;
  // the filter is the single source of truth for what prints.
  const sheet = $derived(invitesForSheet(invites));

  function print() {
    window.print();
  }
</script>

<!-- Keyboard-modal dialog (audit U14): initial focus + focus trap + focus restore
     via the shared focusTrap action, Escape closes, and the heading is associated
     as the accessible name (aria-labelledby), matching AdminPersonDrawer. -->
<div
  class="invite-sheet-overlay"
  role="dialog"
  aria-modal="true"
  aria-labelledby="invite-sheet-title"
  tabindex="-1"
  use:focusTrap
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }}
>
  <div class="sheet-toolbar no-print">
    <strong id="invite-sheet-title">{t("admin.inviteSheet.title")}</strong>
    <div class="row" style="gap:0.5rem">
      <button class="btn inline primary" onclick={print}>{t("admin.inviteSheet.print")}</button>
      <button class="btn inline" onclick={onClose}>{t("admin.inviteSheet.close")}</button>
    </div>
  </div>

  <div class="invite-sheet">
    <div class="cards">
      {#each sheet as inv (inv.nsec)}
        <div class="invite-card">
          <QrCode data={inv.link} size={180} />
          <div class="meta">
            <strong>{inv.label}</strong>
            <p class="event">{eventTitle}</p>
            <p class="hint">{t("admin.inviteSheet.scanHint")}</p>
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .invite-sheet-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--bg);
    overflow-y: auto;
    padding: 1rem;
  }
  .sheet-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 1rem;
  }
  .invite-card {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.85rem;
    break-inside: avoid;
    background: #fff;
    color: #000;
  }
  .meta {
    min-width: 0;
  }
  .meta strong {
    font-size: 1.1rem;
  }
  .event {
    margin: 0.2rem 0;
    font-weight: 600;
  }
  .hint {
    margin: 0.2rem 0 0;
    font-size: 0.78rem;
    color: #555;
  }

  /* Print only the sheet, whatever's behind it (classic isolate-one-element). */
  @media print {
    :global(body:has(.invite-sheet) *) {
      visibility: hidden;
    }
    :global(body:has(.invite-sheet) .invite-sheet),
    :global(body:has(.invite-sheet) .invite-sheet *) {
      visibility: visible;
    }
    .invite-sheet-overlay {
      position: static;
      padding: 0;
    }
    .cards {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
