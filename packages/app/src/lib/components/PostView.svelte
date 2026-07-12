<script lang="ts">
  import type { RecentPost } from "$lib/events/social.js";
  import { parsePostContent, imetaUrls } from "$lib/social/render.js";

  let { post }: { post: RecentPost } = $props();

  const tokens = $derived(parsePostContent(post.content, imetaUrls(post.tags)));
  const when = $derived(new Date(post.created_at * 1000).toLocaleDateString());

  function shortMention(bech32: string) {
    return "@" + bech32.slice(0, 10) + "…";
  }
</script>

<div class="card" style="background:var(--bg-elev2)">
  <p class="muted" style="margin:0 0 0.5rem">{when}</p>
  <div style="white-space:pre-wrap;word-break:break-word">
    {#each tokens as t, i (i)}
      {#if t.type === "text"}{t.value}{:else if t.type === "link"}<a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer">{t.url}</a
        >{:else if t.type === "mention"}<span class="badge">{shortMention(t.bech32)}</span
        >{/if}
    {/each}
  </div>
  {#each tokens.filter((t) => t.type === "image") as img, i (i)}
    <img
      src={(img as { url: string }).url}
      alt=""
      loading="lazy"
      style="max-width:100%;border-radius:8px;margin-top:0.5rem"
    />
  {/each}
</div>
