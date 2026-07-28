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
    usedPubkeys,
    onClose,
  }: {
    invites: GeneratedInvite[];
    eventTitle: string;
    /**
     * Invite-pubkeys already redeemed (from `redeemedInvitePubkeys`). Optional and
     * empty-by-default: a caller with no redemption data must get the whole sheet,
     * never a silently shortened one.
     */
    usedPubkeys?: ReadonlySet<string>;
    onClose: () => void;
  } = $props();

  onMount(() => enterSecretSurface());

  // The filter is the single source of truth for what prints. Reactive over
  // `usedPubkeys`, so a walk-in who scans a code while this overlay is open drops
  // off it on the next report refresh — the door case this exists for.
  const sheet = $derived(invitesForSheet(invites, usedPubkeys));

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
          <!-- 512, not the 180 this used to render, and NOT the size it's shown
               at: QrCode rasterises to a PNG data URL of exactly `size` px, and
               the CSS below scales that raster to 13rem on screen / 5cm on paper.
               A join link is ~260 chars (origin + naddr + a 63-char nsec), which
               is a version-12 code — 65 modules plus a 1-module quiet zone. At
               180 px that was 2.69 px per module, i.e. non-integer module widths
               that a 300dpi printer then resampled into mush. 512 px gives 7.6
               px per module, enough for both a 3x-DPR screen and the printer. -->
          <QrCode data={inv.link} size={512} />
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
    /* `min(100%, …)` because a bare `minmax(17rem, 1fr)` makes the track wider
       than the container on a 390px phone (overlay padding leaves 358px) and the
       whole grid overflows sideways. */
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
    gap: 1rem;
  }
  /* QR ON TOP, text underneath — this was a row (180px QR beside .meta) inside a
     grid whose tracks could be as narrow as 15rem/240px. Take the QR, the 0.75rem
     gap and 2x0.85rem padding out of 240 and .meta was left with ~30px, so every
     label broke as "invite-"/"14", a four-word event title took four lines, and
     the words that couldn't break at all spilled outside the rounded border
     (reported from production). Stacking gives the text the card's full width at
     any viewport instead of the QR's leftovers. */
  .invite-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    text-align: center;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.85rem;
    break-inside: avoid;
    background: #fff;
    color: #000;
    /* Last-resort break for an unbroken title (a long hashtag, a URL) that would
       otherwise still poke through the border. */
    overflow-wrap: break-word;
  }
  /* Sizes the QR by its CSS box, not by the raster QrCode generated (see the
     size={512} note above) — :global because the <img> belongs to QrCode. */
  .invite-card :global(img) {
    width: 100%;
    max-width: 13rem;
    height: auto;
  }
  .meta {
    /* Full card width, so the flex column doesn't shrink it to min-content. */
    width: 100%;
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

  /* Print only the sheet — and start it on page 1.
     This used to isolate the sheet with `visibility: hidden` on everything plus
     `visible` on the sheet, which printed five pages: three blank, then the cards
     crammed into the bottom of the last two. `visibility: hidden` keeps an
     element's layout box, so the entire (very long) Admin page behind the overlay
     still occupied its full height, and the sheet printed where it genuinely sits
     in the document — the end. Only `display: none` collapses that space.
     Measured in a headless-Chrome PDF of a repro of this component over a
     stand-in Admin page: 5 pages / cards starting on page 4 before, 2 pages /
     cards from the top of page 1 after.
     The overlay is nested (body > .app-shell > main > Admin > overlay), so
     display:none'ing "everything else" must not catch the sheet's ANCESTORS or it
     takes the sheet down with them; `:has(.invite-sheet)` is what spares them.
     The overlay also has to stop being `position: fixed` (fixed boxes print on
     page 1 only) and stop being a scroll container (`overflow: auto` clips at the
     first page instead of paginating). */
  @media print {
    :global(
      body:has(.invite-sheet) *:not(:has(.invite-sheet), .invite-sheet, .invite-sheet *)
    ) {
      display: none !important;
    }
    /* The 640px --maxw reading measure is a screen concern; on paper it would
       throw away ~2cm of usable width on each side of an A4 sheet. */
    :global(body:has(.invite-sheet) .app-shell) {
      max-width: none;
      padding: 0;
    }
    /* body's `var(--bg)` propagates to the page canvas, so on a dark theme it
       floods every sheet page — see the overlay note below. `min-height: 100dvh`
       is a viewport unit that has no business setting the height of a printed
       document. */
    :global(html:has(.invite-sheet)),
    :global(body:has(.invite-sheet)) {
      background: #fff;
      color: #000;
      min-height: 0;
    }
    .invite-sheet-overlay {
      position: static;
      overflow: visible;
      padding: 0;
      /* Paper is white. The overlay paints `var(--bg)` so it hides the app behind
         it on screen, and app.css sets `print-color-adjust: exact` on everything
         (so report banners survive printing) — which means a dark-theme organizer
         would otherwise get every sheet page flooded solid near-black around the
         cards. The cards already force #fff/#000 for the same reason. */
      background: #fff;
      color: #000;
    }
    .cards {
      grid-template-columns: repeat(2, 1fr);
    }
    /* Bigger on paper than on screen: a phone camera needs physical size and a
       real quiet zone (QrCode passes margin:1) to read a ~70-module code. 5cm
       across is ~0.7mm per module; the previous 180 CSS px would have been 4.8cm
       of blurry upscale from a 180px raster. */
    .invite-card :global(img) {
      max-width: none;
      width: 5cm;
    }
  }
</style>
