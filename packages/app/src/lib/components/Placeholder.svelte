<script lang="ts">
  let { title, phase }: { title: string; phase: string } = $props();
</script>

<h1>{title}</h1>
<div class="card">
  <p class="muted">This screen arrives in <strong>{phase}</strong>.</p>
</div>
