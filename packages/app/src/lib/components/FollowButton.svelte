<script lang="ts">
  /**
   * Follow / unfollow toggle for a person row (user request 2026-08-07).
   *
   * The roster used to carry a static "following" badge: it stated a fact and
   * offered nothing to do about it, and nowhere in the app could a follow be
   * undone at all.
   *
   * At rest the button shows the STATE ("following" / "not following"); under
   * the pointer or keyboard focus it shows what clicking will DO ("Unfollow" /
   * "Follow!"). Both labels sit in the same grid cell, so the button is sized to
   * the wider of the two and the row does not reflow as the pointer crosses it.
   *
   * Hover is decoration, not the mechanism: the accessible name and the tooltip
   * always name the action, and `aria-pressed` carries the state, so a touch or
   * screen-reader user gets the same information without ever hovering.
   */
  import { session } from "$lib/signer/session.svelte.js";
  import { followUser, unfollowUser } from "$lib/events/nostr-actions.js";
  import { noteFollowChange } from "$lib/events/social.js";
  import { opStatus } from "$lib/stores/op-status.svelte.js";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    pubkey,
    name,
    following,
    onChange,
  }: {
    pubkey: string;
    name: string;
    following: boolean;
    /** Report the new state so the owner of the follow set stays authoritative. */
    onChange: (following: boolean) => void;
  } = $props();

  let busy = $state(false);

  const hint = $derived(
    following ? t("follow.unfollowName", { name }) : t("follow.followName", { name }),
  );

  async function toggle() {
    if (!session.signer || busy) return;
    const next = !following;
    busy = true;
    try {
      const published = next
        ? await followUser(session.signer, pubkey)
        : await unfollowUser(session.signer, pubkey);
      noteFollowChange(pubkey, next);
      onChange(next);
      // Queued for the offline flush rather than published (audit UX-15) — say
      // so, instead of letting the flipped badge imply it reached a relay.
      if (!published) {
        outbox.noteQueued();
        opStatus.queued(t("sync.queued"));
      }
    } catch (e) {
      // The empty-list guard reports here too: it is the one failure a user can
      // act on, and swallowing it would leave the badge silently unchanged.
      opStatus.fail(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }
</script>

<button
  class="follow"
  class:on={following}
  aria-pressed={following}
  aria-busy={busy}
  disabled={busy}
  title={hint}
  aria-label={hint}
  onclick={toggle}
>
  <span class="labels">
    <span class="state">{following ? t("follow.following") : t("follow.notFollowing")}</span>
    <span class="action">{following ? t("follow.unfollow") : t("follow.follow")}</span>
    <span class="busy" aria-hidden="true">…</span>
  </span>
</button>

<style>
  .follow {
    display: inline-flex;
    align-items: center;
    /* Reads as a sibling of the badges it sits beside, but bordered so it is
       visibly a control rather than another piece of status text. */
    min-height: 30px;
    padding: 0.18rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elev2);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.01em;
    cursor: pointer;
  }
  .follow.on {
    background: var(--ok-soft);
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 30%, transparent);
  }
  .follow:hover:not(:disabled),
  .follow:focus-visible {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .follow:active:not(:disabled) {
    transform: translateY(1px);
  }
  .follow:disabled {
    cursor: progress;
  }

  /* One cell, three labels: the button is as wide as the widest of them, so
     swapping state → action on hover cannot shift the row under the pointer.
     `visibility` (not `display`) is what keeps the hidden ones sizing the cell. */
  .labels {
    display: inline-grid;
    place-items: center;
  }
  .labels > span {
    grid-area: 1 / 1;
    white-space: nowrap;
  }
  .action,
  .busy {
    visibility: hidden;
  }
  .follow:hover:not(:disabled) .state,
  .follow:focus-visible .state {
    visibility: hidden;
  }
  .follow:hover:not(:disabled) .action,
  .follow:focus-visible .action {
    visibility: visible;
  }
  .follow[aria-busy="true"] .state,
  .follow[aria-busy="true"] .action {
    visibility: hidden;
  }
  .follow[aria-busy="true"] .busy {
    visibility: visible;
  }
</style>
