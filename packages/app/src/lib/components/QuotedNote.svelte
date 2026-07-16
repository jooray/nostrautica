<script lang="ts">
  /**
   * A compact quoted note (a `nostr:note1…`/`nevent1…` embed inside a post, or a
   * reply's parent). Resolves the referenced event + its author's kind-0 and
   * renders author + a short body with inline images/video — like a real Nostr
   * client (user feedback 2026-07-17: the feed was flat plaintext). Never recurses
   * into further embeds, so a quote-of-a-quote can't loop.
   */
  import { onMount } from "svelte";
  import { decode } from "nostr-tools/nip19";
  import { KIND_NOTE, KIND_LONGFORM, parseCoordinate } from "@nostrautica/protocol";
  import { connectNdk, fetchEvents } from "$lib/nostr/ndk.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { parsePostContent, imetaUrls } from "$lib/social/render.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    bech32,
    id,
    label,
  }: {
    /** A note/nevent/naddr bech32 to resolve. */
    bech32?: string;
    /** Or a raw event id (used for reply parents). */
    id?: string;
    /** Optional heading (e.g. "In reply to"). */
    label?: string;
  } = $props();

  let author = $state<string>("");
  let profile = $state<ProfileMeta | undefined>(undefined);
  let content = $state<string>("");
  let tags = $state<string[][]>([]);
  let loading = $state(true);
  let failed = $state(false);

  onMount(async () => {
    try {
      await connectNdk();
      const ev = await resolve();
      if (!ev) {
        failed = true;
        return;
      }
      author = ev.pubkey;
      content = ev.content;
      tags = ev.tags;
      profile = cachedProfiles([author]).get(author);
      profile = (await fetchProfiles([author]).catch(() => new Map())).get(author) ?? profile;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });

  async function resolve(): Promise<{ pubkey: string; content: string; tags: string[][] } | undefined> {
    if (id) {
      const [e] = await fetchEvents({ ids: [id] });
      return e ? { pubkey: e.pubkey, content: e.content, tags: e.tags } : undefined;
    }
    if (!bech32) return undefined;
    const d = decode(bech32);
    if (d.type === "note") {
      const [e] = await fetchEvents({ ids: [d.data] });
      return e ? { pubkey: e.pubkey, content: e.content, tags: e.tags } : undefined;
    }
    if (d.type === "nevent") {
      const [e] = await fetchEvents({ ids: [d.data.id] });
      return e ? { pubkey: e.pubkey, content: e.content, tags: e.tags } : undefined;
    }
    if (d.type === "naddr") {
      const { pubkey, kind, identifier } = d.data;
      const [e] = await fetchEvents({
        kinds: [kind],
        authors: [pubkey],
        "#d": [identifier],
      });
      return e ? { pubkey: e.pubkey, content: e.content, tags: e.tags } : undefined;
    }
    return undefined;
  }

  const name = $derived(profile?.name || (author ? author.slice(0, 8) + "…" : ""));
  // Only text + inline media inside a quote — no nested @mentions/embeds resolution.
  const tokens = $derived(content ? parsePostContent(content, imetaUrls(tags)) : []);
  const preview = $derived(
    tokens
      .filter((tk) => tk.type === "text" || tk.type === "link")
      .map((tk) => (tk.type === "text" ? tk.value : (tk as { url: string }).url))
      .join("")
      .trim()
      .slice(0, 280),
  );
  const images = $derived(tokens.filter((tk) => tk.type === "image").map((tk) => (tk as { url: string }).url));
</script>

{#if !failed}
  <div class="quote" class:loading>
    {#if label}<span class="qlabel">{label}</span>{/if}
    {#if loading}
      <div class="sk" style="width:60%"></div>
      <div class="sk" style="width:90%;margin-top:0.4rem"></div>
    {:else}
      <div class="qhead">
        <Avatar pubkey={author} name={profile?.name} picture={profile?.picture} size={24} />
        <strong class="qname">{name}</strong>
      </div>
      {#if preview}<p class="qbody">{preview}</p>{/if}
      {#each images.slice(0, 2) as img (img)}
        <img class="qimg" src={img} alt="" loading="lazy" />
      {/each}
    {/if}
  </div>
{:else if !loading}
  <div class="quote failed">
    <span class="muted">{t("post.quote.unavailable")}</span>
  </div>
{/if}

<style>
  .quote {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.55rem 0.7rem;
    margin: 0.5rem 0 0;
    background: var(--bg-elev, transparent);
  }
  .qlabel {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin-bottom: 0.3rem;
  }
  .qhead {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .qname {
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qbody {
    margin: 0.35rem 0 0;
    font-size: 0.9rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .qimg {
    max-width: 100%;
    max-height: 180px;
    border-radius: 8px;
    margin-top: 0.4rem;
    object-fit: cover;
  }
  .sk {
    height: 0.75rem;
    border-radius: 0.4rem;
    background: var(--bg-elev2, rgba(128, 128, 128, 0.15));
    animation: q-pulse 1.2s ease-in-out infinite;
  }
  @keyframes q-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sk {
      animation: none;
    }
  }
</style>
