<script lang="ts">
  import { onMount } from "svelte";
  import { decode } from "nostr-tools/nip19";
  import type { RecentPost } from "$lib/events/social.js";
  import { fetchProfiles, cachedProfiles } from "$lib/events/social.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { parsePostContent, imetaUrls, type Token } from "$lib/social/render.js";
  import QuotedNote from "$lib/components/QuotedNote.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { post }: { post: RecentPost } = $props();

  const tokens = $derived(parsePostContent(post.content, imetaUrls(post.tags)));
  const when = $derived(new Date(post.created_at * 1000).toLocaleDateString());

  // A reply's parent renders above the body (NIP-10: prefer the "reply" marker,
  // then "root", else the last positional e-tag).
  const replyToId = $derived.by(() => {
    const es = post.tags.filter((tg) => tg[0] === "e");
    if (es.length === 0) return undefined;
    const marked = es.find((tg) => tg[3] === "reply") ?? es.find((tg) => tg[3] === "root");
    return (marked ?? es[es.length - 1])[1];
  });

  // Resolve @-mention display names (npub/nprofile → kind-0 name).
  let names = $state<Map<string, string>>(new Map());
  onMount(async () => {
    const pubkeys: string[] = [];
    for (const tk of tokens) {
      if (tk.type !== "mention") continue;
      try {
        const d = decode(tk.bech32);
        if (d.type === "npub") pubkeys.push(d.data);
        else if (d.type === "nprofile") pubkeys.push(d.data.pubkey);
      } catch {
        /* skip */
      }
    }
    if (pubkeys.length === 0) return;
    const paint = (m: Map<string, { name?: string }>) => {
      const next = new Map(names);
      for (const [pk, meta] of m) if (meta.name) next.set(pk, meta.name);
      names = next;
    };
    paint(cachedProfiles(pubkeys)); // instant from cache, then refresh
    await connectNdk().catch(() => {});
    paint(await fetchProfiles(pubkeys).catch(() => new Map()));
  });

  function mentionName(bech32: string): string {
    try {
      const d = decode(bech32);
      const pk = d.type === "npub" ? d.data : d.type === "nprofile" ? d.data.pubkey : undefined;
      const nm = pk ? names.get(pk) : undefined;
      if (nm) return "@" + nm;
    } catch {
      /* fall through */
    }
    return "@" + bech32.slice(0, 10) + "…";
  }

  // Text/link/mention flow inline; images/videos/quoted embeds render as blocks.
  const inlineTypes = new Set(["text", "link", "mention"]);
  const inline = $derived(tokens.filter((tk) => inlineTypes.has(tk.type)));
  const blocks = $derived(tokens.filter((tk) => !inlineTypes.has(tk.type)));
  const hasInlineText = $derived(inline.some((tk) => (tk.type === "text" ? tk.value.trim() : true)));
</script>

<div class="card post">
  <p class="muted when">{when}</p>

  {#if replyToId}
    <QuotedNote id={replyToId} label={t("post.replyingTo")} />
  {/if}

  {#if hasInlineText}
    <div class="body">
      {#each inline as tk, i (i)}
        {#if tk.type === "text"}{tk.value}{:else if tk.type === "link"}<a
            href={tk.url}
            target="_blank"
            rel="noopener noreferrer">{tk.url}</a
          >{:else if tk.type === "mention"}<a
            class="mention"
            href={`https://njump.me/${tk.bech32}`}
            target="_blank"
            rel="noopener noreferrer">{mentionName(tk.bech32)}</a
          >{/if}
      {/each}
    </div>
  {/if}

  {#each blocks as tk, i (i)}
    {#if tk.type === "image"}
      <img class="media" src={(tk as Extract<Token, { type: "image" }>).url} alt="" loading="lazy" />
    {:else if tk.type === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="media" src={(tk as Extract<Token, { type: "video" }>).url} controls preload="metadata"
      ></video>
    {:else if tk.type === "embed"}
      <QuotedNote bech32={(tk as Extract<Token, { type: "embed" }>).bech32} />
    {/if}
  {/each}
</div>

<style>
  .post {
    background: var(--bg-elev2);
  }
  .when {
    margin: 0 0 0.5rem;
  }
  .body {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .mention {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .mention:hover {
    text-decoration: underline;
  }
  .media {
    display: block;
    max-width: 100%;
    border-radius: 8px;
    margin-top: 0.5rem;
  }
  video.media {
    max-height: 420px;
    background: #000;
  }
</style>
