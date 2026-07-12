<script lang="ts">
  import Placeholder from "$lib/components/Placeholder.svelte";
  let { naddr, code }: { naddr: string; code?: string } = $props();
</script>
<Placeholder title="Join event" phase="P2" />
