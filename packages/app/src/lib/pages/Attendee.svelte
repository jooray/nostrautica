<script lang="ts">
  import Placeholder from "$lib/components/Placeholder.svelte";
  let { naddr, npub }: { naddr: string; npub: string } = $props();
</script>
<Placeholder title="Attendee" phase="P2" />
