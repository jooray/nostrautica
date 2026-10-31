<script lang="ts">
  /**
   * Approved-people domain (Phase 5C carry-over b — Admin domain split). Owns the
   * inline revoke-confirmation interaction state; the parent keeps the source list
   * and performs the actual revoke/reprocess/details actions (which mutate its data
   * model), told via callbacks. Same shape as AdminTalks.
   */
  import type { AdminPerson, ChatAttendeeStatus } from "$lib/events/admin-people.js";
  import type { MessageKey } from "$lib/i18n/messages.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  /** Badge label and its tooltip, per chat status (audit U-3). */
  const CHAT_STATUS: Record<ChatAttendeeStatus, [MessageKey, MessageKey]> = {
    "in-room": ["admin.chat.inRoom", "admin.chat.inRoomHint"],
    waiting: ["admin.chat.waiting", "admin.chat.waitingHint"],
    attested: ["admin.chat.attested", "admin.chat.attestedHint"],
    "not-yet": ["admin.chat.notYet", "admin.chat.notYetHint"],
    stuck: ["admin.chat.stuck", "admin.chat.stuckHint"],
    refused: ["admin.chat.refused", "admin.chat.refusedHint"],
  };
  import PersonId from "$lib/components/PersonId.svelte";

  let {
    people,
    relays,
    filterActive,
    matchedPubkeys,
    onRevoke,
    onReprocess,
    onDetails,
  }: {
    /** The full approved-people list (the header count uses its length). */
    people: AdminPerson[];
    /** Event relays, used as nprofile hints when copying someone's id. */
    relays: string[];
    /** Whether the parent's people search/filter is narrowing the visible rows. */
    filterActive: boolean;
    /** Pubkeys matching the active filter (rows outside are hidden). */
    matchedPubkeys: Set<string>;
    onRevoke: (pubkey: string) => void;
    onReprocess: (pubkey: string) => void;
    onDetails: (pubkey: string) => void;
  } = $props();

  // Owned interaction state: which card is showing its revoke confirmation.
  let confirmingRevoke = $state<string | null>(null);

  function confirmRevoke(pubkey: string) {
    onRevoke(pubkey);
    confirmingRevoke = null;
  }
</script>

{#if people.length}
  <h2 class="section-head">{t("admin.section.people")}</h2>
  <h2>{t("admin.approved.title", { n: people.length })}</h2>
  <!-- Stable, non-translated anchor for tooling (e2e/screenshot-refresh.mjs
       organizer/08-revoke): mirrors the id="join-requests" hook AdminQueue
       already carries for the same reason — a translated button label is not
       a safe cross-locale selector, but this id is. -->
  <div class="stack" id="approved-people">
    {#each people.filter((p) => !filterActive || matchedPubkeys.has(p.pubkey)) as person (person.pubkey)}
      <div class="card">
        <PersonId pubkey={person.pubkey} name={person.name} {relays} />
        {#if person.role === "organizer"}<span class="badge">{t("admin.people.organizer")}</span>{/if}
        {#if person.media?.length}<span class="badge">{tp("admin.requests.video", person.media.length)}</span>{/if}
        {#if person.op === "failed"}<span class="badge warn">{t("admin.people.failed")}</span>{/if}
        {#if person.chat}
          <!-- Group-chat status (audit U-3). "stuck" and "refused" are the ones an
               organizer must see: the member is out of the chat and nothing on
               their side will fix it. -->
          <span
            class="badge"
            class:warn={person.chat === "stuck" || person.chat === "refused"}
            title={t(CHAT_STATUS[person.chat][1])}>{t(CHAT_STATUS[person.chat][0])}</span
          >
        {/if}
        {#if !person.intakeAvailable && !person.revoked}
          <!-- UX-A1: a roster member whose intake aged out of the backfill window
               still gets a card + working controls, never silently omitted. -->
          <p class="muted" style="margin:0.25rem 0">{t("admin.people.intakeUnavailable")}</p>
        {/if}
        {#if person.withdrawn && !person.revoked}
          <!-- They sent a 21610 asking to leave and nothing acted on it. Only
               reachable without a coordinator (with one, the daemon runs the whole
               revoke chain and republishes a roster they are not in). Their client
               has ALREADY deleted their media and their self-copy and told them the
               request was sent, so the honest state is "they are gone, the roster
               just doesn't say so yet" — and Revoke, right below, is what makes it
               true. -->
          <p class="withdrew" role="status">
            {person.withdrawalRequestedPurge
              ? t("admin.people.withdrew.purge")
              : t("admin.people.withdrew")}
          </p>
        {/if}
        {#if person.revoked}
          <p class="muted">{t("admin.revoked")}</p>
        {:else if confirmingRevoke === person.pubkey}
          <p class="muted" style="margin:0.25rem 0">
            {t("admin.revoke.confirm")}
          </p>
          <div class="row">
            <button class="btn inline danger" onclick={() => confirmRevoke(person.pubkey)}>{t("admin.revoke.revoke")}</button>
            <button class="btn inline" onclick={() => (confirmingRevoke = null)}>{t("admin.revoke.keep")}</button>
          </div>
        {:else}
          <p class="muted">{t("admin.approvedTag")}</p>
          <div class="row">
            <button class="btn inline" onclick={() => onReprocess(person.pubkey)}>{t("admin.reprocess")}</button>
            <button class="btn inline danger" onclick={() => (confirmingRevoke = person.pubkey)}>
              {t("admin.revoke.revoke")}
            </button>
            <button class="btn inline" onclick={() => onDetails(person.pubkey)}>
              {t("admin.person.details")}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .withdrew {
    color: var(--danger);
    margin: 0.25rem 0;
  }
  .section-head {
    margin-top: 1.5rem;
  }
</style>
