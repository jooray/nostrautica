<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchTalks, cachedTalks, type TalkItem } from "$lib/events/talks.js";
  import { fetchProfiles, cachedProfiles, avatarInfo, type ProfileMeta } from "$lib/events/social.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  // Cache-first paint (§2.5): last-seen talks render instantly, then refresh.
  const initialItems = cachedCtx ? (cachedTalks(cachedCtx.coordinate) ?? []) : [];
  let items = $state<TalkItem[]>(initialItems);
  // Author kind-0 profiles (name + picture), resolved the same way People does so
  // a talk card shows the SPEAKER's real avatar, not a bare initials fallback
  // (which, when the speaker is the viewer, looked identical to the More tab).
  let profiles = $state<Map<string, ProfileMeta>>(
    cachedProfiles(initialItems.map((it) => it.talk.pubkey)),
  );
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  let loading = $state(items.length === 0);
  let error = $state<unknown>(null);
  // EOSE reached (a successful fetch settled): the empty state is only truthful
  // AFTER this — before it, an empty list is "still loading", never "no talks".
  let loaded = $state(false);
  let gatedOff = $state(false);

  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  if (items.length) perfMark("Talks", "cache-paint");

  // Resolve author avatars for a set of talks (cache-first, background refresh).
  function loadProfiles(list: TalkItem[]): void {
    const pubkeys = [...new Set(list.map((it) => it.talk.pubkey))];
    if (pubkeys.length === 0) return;
    profiles = new Map([...profiles, ...cachedProfiles(pubkeys)]);
    void fetchProfiles(pubkeys)
      .then((m) => {
        if (m.size) profiles = new Map([...profiles, ...m]);
      })
      .catch(() => {});
  }

  // Cache-paint after background hydration (§7.4.5): boot doesn't await the IDB
  // mirror, so re-read the last-seen talks when hydration lands while we're still
  // empty — a talk seen on this device must never flash the empty state on a cold
  // boot just because the mirror hadn't warmed yet.
  $effect(() => {
    void cacheHydration.version;
    if (items.length > 0) return;
    const c = ctx ?? cachedEventContext(naddr);
    if (!c) return;
    const cached = cachedTalks(c.coordinate) ?? [];
    if (cached.length === 0) return;
    items = cached;
    loadProfiles(cached);
    loading = false;
    perfMark("Talks", "cache-paint");
  });

  async function reload(): Promise<void> {
    error = null;
    loading = items.length === 0;
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Hard gate (spec F2): a talks-off event has no Talks surface at all.
      if (ctx.config.talks === "off") {
        gatedOff = true;
        return;
      }
      // fetchTalks preserves a prior non-empty cache on a transient empty/no-ECK
      // response, so this cannot blank a talk we've already seen (bug: a live
      // event's one talk flickered to "no talks yet" on a relay/ECK hiccup).
      items = await fetchTalks(ctx);
      loaded = true;
      loadProfiles(items);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("Talks", "network-settled");
    }
  }

  onMount(() => {
    loadProfiles(items);
    void reload();
  });
</script>

<h1>{t("talks.title")}</h1>

{#if gatedOff}
  <div class="card"><p class="muted">{t("talks.disabled")}</p></div>
{:else if error && items.length === 0}
  <!-- Actual fetch failure with nothing cached to fall back to: show the error
       and a working retry — never the "no talks yet" empty state (which would
       misreport a load failure as an empty event). -->
  <ErrorState {error} onRetry={reload} retrying={loading} />
{:else if loading}
  <div class="card"><p class="muted">{t("app.loading")}</p></div>
{:else}
  {#if session.loggedIn}
    <div class="row" style="margin-bottom:0.75rem">
      <button class="btn primary" onclick={() => router.go({ name: "record", naddr, talk: true })}>
        {t("talks.submit")}
      </button>
    </div>
  {/if}

  {#if items.length === 0}
    {#if loaded}
      <!-- Only after a successful EOSE with zero talks — never before. -->
      <div class="card" role="status">
        <strong>{t("talks.empty.title")}</strong>
        <p class="muted">{t("talks.empty.body")}</p>
      </div>
    {:else}
      <div class="card"><p class="muted">{t("app.loading")}</p></div>
    {/if}
  {:else}
    <div class="stack">
      {#each items as it (it.d)}
        <button class="card talk-card" onclick={() => router.go({ name: "talk", naddr, d: it.d })}>
          <div class="row" style="align-items:flex-start;gap:0.6rem">
            <Avatar pubkey={it.talk.pubkey} {...avatarInfo(it.talk.pubkey, profiles)} size={40} />
            <div style="flex:1;min-width:0;text-align:left">
              <strong>{it.talk.title}</strong>
              {#if it.talk.description}
                <p class="muted" style="margin:0.25rem 0 0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">
                  {it.talk.description}
                </p>
              {/if}
              <div class="row" style="flex-wrap:wrap;margin-top:0.35rem">
                {#if it.talk.media}
                  <span class="badge">{it.talk.media.kind === "talk" ? t("record.kind.talk") : t("record.kind.intro")}{it.talk.media.duration ? ` · ${it.talk.media.duration}s` : ""}</span>
                {:else if it.talk.external_url}
                  <span class="badge">{t("talks.mod.externalLabel")}</span>
                {/if}
                {#if it.talk.transcript}<span class="badge">{t("talks.hasTranscript")}</span>{/if}
              </div>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .talk-card {
    width: 100%;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    font: inherit;
    color: inherit;
  }
</style>
