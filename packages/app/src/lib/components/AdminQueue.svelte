<script lang="ts">
  /**
   * Join-request queue domain (Phase 5C carry-over b — Admin domain split). Owns
   * the inline reject-confirmation interaction state; the parent keeps the durable
   * queue, the bulk-approval machinery, and the persisted review state, and
   * performs approve/review/retry (which mutate its data model) via callbacks.
   * Same shape as AdminTalks — the child is the queue's render + confirm surface.
   */
  import type { PendingRequest } from "$lib/events/organizer.js";
  import type { BulkItem } from "$lib/events/admin-people.js";
  import type { ReviewState } from "$lib/stores/review-state.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  let {
    requests,
    filterActive,
    matchedPubkeys,
    deferredSet,
    rejectedSet,
    approving,
    approvingAll,
    bulkRan,
    bulkSummary,
    bulkItemState,
    onApprove,
    onApproveAll,
    onReview,
    onRetryBulk,
    onDetails,
  }: {
    /** The full pending queue (the count/header use its length). */
    requests: PendingRequest[];
    filterActive: boolean;
    matchedPubkeys: Set<string>;
    deferredSet: Set<string>;
    rejectedSet: Set<string>;
    /** Pubkeys with a single approval in flight (per-request busy guard). */
    approving: Set<string>;
    approvingAll: boolean;
    bulkRan: boolean;
    bulkSummary: { done: boolean; approved: number; needRetry: number };
    bulkItemState: (pubkey: string) => BulkItem["state"] | undefined;
    onApprove: (req: PendingRequest) => void;
    onApproveAll: () => void;
    onReview: (pubkey: string, state: ReviewState | undefined) => void;
    onRetryBulk: (pubkey: string) => void;
    onDetails: (pubkey: string) => void;
  } = $props();

  // Owned interaction state: which request is showing its reject confirmation.
  let confirmingReject = $state<string | null>(null);

  const short = (pk: string) => pk.slice(0, 8) + "…" + pk.slice(-4);

  function doReject(pubkey: string) {
    onReview(pubkey, "rejected");
    confirmingReject = null;
  }
  function undoAllRejects() {
    for (const pk of rejectedSet) onReview(pk, undefined);
  }
</script>

<h2 id="join-requests">{t("admin.requests.title")}</h2>
<div class="stack">
  {#if requests.length === 0}
    <p class="muted">{t("admin.requests.none")}</p>
  {:else if requests.length > 1}
    <button class="btn" onclick={onApproveAll} disabled={approvingAll}>
      {approvingAll ? t("admin.requests.approving") : t("admin.requests.approveAll", { n: requests.length })}
    </button>
  {/if}
  {#if bulkRan && bulkSummary.done && (bulkSummary.approved > 0 || bulkSummary.needRetry > 0)}
    <!-- UX-A4 final tally after a bulk run: N approved, M need retry. -->
    <p class="muted" role="status" aria-live="polite" style="margin:0.25rem 0">
      {t("admin.requests.bulkSummary", { approved: bulkSummary.approved, retry: bulkSummary.needRetry })}
    </p>
  {/if}
  {#each requests.filter((r) => !filterActive || matchedPubkeys.has(r.attendeePubkey)) as req (req.attendeePubkey)}
    {@const bulk = bulkItemState(req.attendeePubkey)}
    {@const deferred = deferredSet.has(req.attendeePubkey)}
    <div class="card">
      <strong>{req.name}</strong>
      <span class="badge">{short(req.attendeePubkey)}</span>
      {#if req.invite}<span class="badge">{t("admin.requests.invite")}</span>{/if}
      {#if deferred}<span class="badge">{t("admin.requests.reviewed")}</span>{/if}
      {#if req.message}<p class="muted">{req.message}</p>{/if}
      {#if req.profile?.skills?.length}
        <div class="row" style="flex-wrap:wrap">
          {#each req.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
        </div>
      {/if}
      {#if req.media?.length}<span class="badge">{tp("admin.requests.video", req.media.length)}</span>{/if}
      {#if bulk === "queued" || bulk === "publishing"}
        <p class="muted" role="status" style="margin:0.25rem 0 0">
          {bulk === "publishing" ? t("admin.requests.bulk.publishing") : t("admin.requests.bulk.queued")}
        </p>
      {:else if bulk === "failed"}
        <p class="muted" style="color:var(--danger);margin:0.25rem 0 0">{t("admin.requests.bulk.failed")}</p>
        <button class="btn inline" onclick={() => onRetryBulk(req.attendeePubkey)}>
          {t("admin.requests.bulk.retry")}
        </button>
      {:else if confirmingReject === req.attendeePubkey}
        <p class="muted" style="margin:0.25rem 0">{t("admin.requests.reject.confirm")}</p>
        <div class="row">
          <button class="btn inline danger" onclick={() => doReject(req.attendeePubkey)}>
            {t("admin.requests.reject")}
          </button>
          <button class="btn inline" onclick={() => (confirmingReject = null)}>{t("admin.revoke.keep")}</button>
        </div>
      {:else}
        <div class="row" style="flex-wrap:wrap">
          <button
            class="btn primary"
            onclick={() => onApprove(req)}
            disabled={approving.has(req.attendeePubkey)}
          >{t("admin.requests.approve")}</button>
          {#if !deferred}
            <button class="btn inline" onclick={() => onReview(req.attendeePubkey, "deferred")}>
              {t("admin.requests.leavePending")}
            </button>
          {/if}
          <button class="btn inline danger" onclick={() => (confirmingReject = req.attendeePubkey)}>
            {t("admin.requests.reject")}
          </button>
          <button class="btn inline" onclick={() => onDetails(req.attendeePubkey)}>
            {t("admin.person.details")}
          </button>
        </div>
      {/if}
    </div>
  {/each}
  {#if rejectedSet.size}
    <p class="muted" style="font-size:0.8rem">
      {tp("admin.requests.rejectedCount", rejectedSet.size)}
      <button
        class="btn inline"
        style="display:inline;padding:0;background:none;border:none;color:var(--accent);text-decoration:underline"
        onclick={undoAllRejects}
      >
        {t("admin.requests.undoRejects")}
      </button>
    </p>
  {/if}
</div>
