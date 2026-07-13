<script lang="ts">
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
</script>

<h1>{t("notfound.title")}</h1>
<p class="muted">{t("notfound.body")}</p>
<button class="btn primary" onclick={() => router.go({ name: "home" })}>{t("notfound.home")}</button>
