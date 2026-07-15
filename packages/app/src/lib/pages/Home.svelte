<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { coordinateToNaddr, parseCoordinate } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { listEventKeys } from "$lib/events/keystore.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { defaultEventIcon } from "$lib/media/image.js";
  import { backupNag, markBackedUp } from "$lib/stores/backup-nag.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  const events = $derived(recentEvents.list);
  const roleLabel = {
    organizer: "home.role.organizer",
    attendee: "home.role.attendee",
    visitor: "home.role.visitor",
  } as const;

  /** A readable placeholder title from a coordinate's identifier. */
  function placeholderTitle(coordinate: string): string {
    let id = "event";
    try {
      id = parseCoordinate(coordinate).identifier;
    } catch {
      /* keep default */
    }
    return id
      .replace(/-[0-9a-f]{6,}$/i, "") // strip the random slug suffix
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || t("home.placeholderEvent");
  }

  // Backfill "My events" from the local key store — every event the user created
  // or was approved into — so events created before this list existed still show.
  onMount(async () => {
    // Fresh-device recovery: read back the 30078 eventkeys backups so events this
    // identity created reappear (and their custody is restored) from relays alone.
    if (session.signer) await recoverEventKeys(session.signer).catch(() => {});
    const keys = await listEventKeys().catch(() => []);
    for (const k of keys) {
      if (recentEvents.has(k.coordinate)) continue;
      recentEvents.record({
        coordinate: k.coordinate,
        naddr: coordinateToNaddr(k.coordinate),
        title: placeholderTitle(k.coordinate),
        role: k.role,
        at: 1, // backfill without bumping to the top
      });
    }
  });
</script>

<h1>{t("home.title")}</h1>
<p class="muted">
  {t("home.intro")}
</p>

{#if session.loggedIn && session.signer?.method === "local" && !backupNag.done}
  <!-- One gentle nudge until the key is backed up (UI-SUGGESTIONS #8). -->
  <div class="card warn">
    <strong>{t("home.backup.title")}</strong>
    <p class="muted" style="margin:0.25rem 0 0.5rem">
      {t("home.backup.body")}
    </p>
    <div class="row">
      <button class="btn inline primary" onclick={() => router.go({ name: "me" })}>
        {t("home.backup.now")}
      </button>
      <button class="btn inline" onclick={() => markBackedUp()}>{t("home.backup.saved")}</button>
    </div>
  </div>
{/if}

{#if events.length}
  <h2>{t("home.yourEvents")}</h2>
  <div class="stack">
    {#each events as e (e.naddr)}
      <button
        class="card row"
        style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center"
        onclick={() => router.go({ name: "event", naddr: e.naddr })}
      >
        <img
          src={e.icon || defaultEventIcon(e.title, e.title)}
          alt=""
          width="44"
          height="44"
          style="border-radius:11px;flex:none"
        />
        <div style="flex:1;min-width:0">
          <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {e.title}
          </strong>
          <span class="badge">{t(roleLabel[e.role])}</span>
        </div>
        <span class="muted">›</span>
      </button>
    {/each}
  </div>
  <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
    <Icon name="plus" size={17} />{t("home.createAnother")}
  </button>
{:else if !session.loggedIn}
  <div class="card">
    <h2>{t("home.getStarted")}</h2>
    <p class="muted">{t("home.getStarted.body")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>
      {t("home.loginOrCreate")}
    </button>
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
      {t("home.createEvent")}
    </button>
  </div>
{:else}
  <div class="card">
    <h2>{t("home.noEvents")}</h2>
    <p class="muted">{t("home.noEvents.body")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "create" })}>
      {t("home.createEvent")}
    </button>
  </div>
{/if}

<div class="card">
  <h2>{t("home.how.title")}</h2>
  <ul class="muted">
    <li>{t("home.how.record")}</li>
    <li>{t("home.how.matched")}</li>
    <li>{t("home.how.encrypted")}</li>
    <li>{t("home.how.portable")}</li>
  </ul>
</div>
