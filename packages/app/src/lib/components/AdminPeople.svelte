<script lang="ts">
  /**
   * Approved-people domain (Phase 5C carry-over b — Admin domain split). Owns the
   * inline revoke-confirmation interaction state; the parent keeps the source list
   * and performs the actual revoke/reprocess/details actions (which mutate its data
   * model), told via callbacks. Same shape as AdminTalks.
   */
  import type { AdminPerson } from "$lib/events/admin-people.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";
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
  <div class="stack">
    {#each people.filter((p) => !filterActive || matchedPubkeys.has(p.pubkey)) as person (person.pubkey)}
      <div class="card">
        <PersonId pubkey={person.pubkey} name={person.name} {relays} />
        {#if person.role === "organizer"}<span class="badge">{t("admin.people.organizer")}</span>{/if}
        {#if person.media?.length}<span class="badge">{tp("admin.requests.video", person.media.length)}</span>{/if}
        {#if person.op === "failed"}<span class="badge warn">{t("admin.people.failed")}</span>{/if}
        {#if !person.intakeAvailable && !person.revoked}
          <!-- UX-A1: a roster member whose intake aged out of the backfill window
               still gets a card + working controls, never silently omitted. -->
          <p class="muted" style="margin:0.25rem 0">{t("admin.people.intakeUnavailable")}</p>
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
  .section-head {
    margin-top: 1.5rem;
  }
</style>
