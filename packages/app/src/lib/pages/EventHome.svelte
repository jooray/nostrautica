<script lang="ts">
  import Placeholder from "$lib/components/Placeholder.svelte";
  let { naddr }: { naddr: string } = $props();
</script>
<Placeholder title="Event" phase="P2" />
<p class="muted mono">{naddr}</p>
