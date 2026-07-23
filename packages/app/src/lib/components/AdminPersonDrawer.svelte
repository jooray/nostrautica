<script lang="ts">
  /**
   * Per-person operational drawer for admin People (Phase 5A carry-over a). Shows,
   * for one attendee, their submitted profile (the intake the organizer approves
   * on), their provenance (role, membership state, intro medium), and an
   * operational history assembled from existing data — coordinator status events
   * and talk submissions — newest first. A proper modal: focus trap + Escape +
   * restore, reusing the shared focus-trap action.
   */
  import type { AttendeeProfile, MediaDescriptor, CoordinatorStatusContent } from "@nostrautica/protocol";
  import { buildPersonDetail } from "$lib/events/admin-person-detail.js";
  import { focusTrap } from "./focus-trap.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import type { MessageKey } from "$lib/i18n/messages.js";
  import Avatar from "./Avatar.svelte";

  let {
    pubkey,
    name,
    role,
    revoked,
    inRoster,
    intakeAvailable,
    pending,
    reviewState,
    profile,
    media,
    introText,
    statuses,
    talks,
    onClose,
  }: {
    pubkey: string;
    name: string;
    role: "attendee" | "organizer";
    revoked: boolean;
    inRoster: boolean;
    intakeAvailable: boolean;
    pending: boolean;
    reviewState?: "rejected" | "deferred";
    profile?: AttendeeProfile;
    media?: MediaDescriptor[];
    introText?: string;
    statuses: CoordinatorStatusContent[];
    talks: { title: string; status: "pending" | "published" | "rejected"; at?: number }[];
    onClose: () => void;
  } = $props();

  const detail = $derived(
    buildPersonDetail({
      role,
      revoked,
      inRoster,
      intakeAvailable,
      pending,
      reviewState,
      profile,
      media,
      introText,
      statuses,
      talks,
    }),
  );

  const membershipTone = $derived(
    detail.provenance.membership === "approved"
      ? "ok"
      : detail.provenance.membership === "pending"
        ? "warn"
        : detail.provenance.membership === "revoked" || detail.provenance.membership === "rejected"
          ? "danger"
          : "",
  );

  const when = (sec?: number) => (sec ? new Date(sec * 1000).toLocaleString() : "");
</script>

<div
  class="backdrop"
  role="dialog"
  aria-modal="true"
  aria-label={t("admin.person.title", { name })}
  tabindex="-1"
  use:focusTrap
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }}
>
  <div class="drawer">
    <header>
      <Avatar {pubkey} {name} size={40} />
      <div class="who">
        <strong>{name}</strong>
        <span class="badges">
          <span class="badge {membershipTone}">{t(`admin.person.membership.${detail.provenance.membership}` as MessageKey)}</span>
          {#if role === "organizer"}<span class="badge">{t("admin.person.role.organizer")}</span>{/if}
        </span>
      </div>
      <button type="button" class="btn inline close" onclick={onClose} aria-label={t("common.close")}>✕</button>
    </header>

    <!-- Submitted profile (the intake the organizer approves on). -->
    <section>
      <h3>{t("admin.person.profile")}</h3>
      {#if !intakeAvailable}
        <p class="muted">{t("admin.person.noIntake")}</p>
      {:else}
        <dl>
          <dt>{t("admin.person.intro")}</dt>
          <dd>{t(`admin.person.intro.${detail.provenance.introKind}` as MessageKey)}</dd>
          {#if profile?.about}
            <dt>{t("admin.person.about")}</dt>
            <dd>{profile.about}</dd>
          {/if}
          {#if profile?.skills?.length}
            <dt>{t("admin.person.skills")}</dt>
            <dd>{profile.skills.join(", ")}</dd>
          {/if}
          {#if profile?.looking_for}
            <dt>{t("admin.person.lookingFor")}</dt>
            <dd>{profile.looking_for}</dd>
          {/if}
          {#if introText?.trim()}
            <dt>{t("admin.person.introText")}</dt>
            <dd style="white-space:pre-wrap">{introText}</dd>
          {/if}
        </dl>
      {/if}
    </section>

    <!-- Operational history from existing coordinator statuses + talks. -->
    <section>
      <h3>{t("admin.person.history")}</h3>
      {#if detail.timeline.length === 0}
        <p class="muted">{t("admin.person.noHistory")}</p>
      {:else}
        <ul class="timeline">
          {#each detail.timeline as e (e.labelKey + (e.at ?? 0) + (e.detail ?? ""))}
            <li>
              <span class="dot {e.tone}" aria-hidden="true"></span>
              <span class="tl-main">
                <span class="tl-label">{t(e.labelKey as MessageKey)}</span>
                {#if e.detail}<span class="tl-detail">{e.detail}</span>{/if}
              </span>
              {#if e.at}<time class="tl-when">{when(e.at)}</time>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    justify-content: flex-end;
  }
  .drawer {
    width: min(30rem, 100vw);
    max-height: 100vh;
    overflow-y: auto;
    background: var(--bg-elev, var(--bg));
    border-left: 1px solid var(--border);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .badges {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .close {
    flex: none;
  }
  section h3 {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.7rem;
  }
  dt {
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  dd {
    margin: 0;
    font-size: 0.9rem;
    min-width: 0;
    word-break: break-word;
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .timeline li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex: none;
    background: var(--text-dim);
  }
  .dot.ok {
    background: var(--ok, #3aa675);
  }
  .dot.warn {
    background: var(--danger);
  }
  .tl-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .tl-detail {
    color: var(--text-dim);
    font-size: 0.82rem;
  }
  .tl-when {
    color: var(--text-dim);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .badge.danger {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
