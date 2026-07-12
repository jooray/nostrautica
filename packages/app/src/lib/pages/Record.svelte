<script lang="ts">
  import Placeholder from "$lib/components/Placeholder.svelte";
  let { naddr, talk }: { naddr: string; talk: boolean } = $props();
</script>
<Placeholder title={talk ? "Record a talk" : "Record your intro"} phase="P3" />
