<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { publishProfile, ensureRelayList, ensureDmRelayList } from "$lib/events/nostr-actions.js";
  import { uploadPublicImage, prepareAvatarImage } from "$lib/media/image.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import SignInOptions from "$lib/components/SignInOptions.svelte";
  import LanguageSwitch from "$lib/components/LanguageSwitch.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let showExisting = $state(false);
  let newName = $state("");
  let picFile = $state<File | null>(null);
  let picPreview = $state("");

  function onPicFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (picPreview) URL.revokeObjectURL(picPreview);
    picFile = f;
    picPreview = URL.createObjectURL(f);
  }

  const createNew = () => {
    error = null;
    busy = true;
    (async () => {
      try {
        await session.createLocalKey();
        const signer = session.signer;
        if (signer) {
          let picture: string | undefined;
          if (picFile) {
            // Downscale + EXIF-strip before upload (audit APPR-3). A bad image
            // aborts here with a readable error — the raw original is never
            // uploaded; an upload failure still proceeds photo-less.
            const avatar = await prepareAvatarImage(picFile);
            picture = await uploadPublicImage(signer, avatar).catch(() => undefined);
          }
          if (newName.trim() || picture) {
            await publishProfile(signer, { name: newName.trim() || undefined, picture }).catch(() => {});
          }
          await ensureRelayList(signer).catch(() => {});
          await ensureDmRelayList(signer).catch(() => {});
        }
        // Stay so the freshly-generated key's backup card shows.
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        busy = false;
      }
    })();
  };

  function done() {
    router.go({ name: "home" });
  }
</script>

{#if session.loggedIn && session.freshLocalKey}
  <h1>{t("login.youreIn")}</h1>
  <div class="card">
    <p class="muted">
      {t("login.created.body")}
    </p>
    <BackupCard />
    <button class="btn primary" onclick={done} style="margin-top:0.75rem">{t("login.continue")}</button>
  </div>
{:else if session.loggedIn}
  <div class="card">
    <p>{t("login.alreadyLoggedIn")}</p>
    <button class="btn primary" onclick={done}>{t("login.continue")}</button>
  </div>
{:else}
  <div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem"><LanguageSwitch /></div>
  <h1>{t("login.welcome")}</h1>

  {#if error}
    <div class="card warn"><strong>{t("login.failed")}</strong> {error}</div>
  {/if}

  <!-- Nostr users are first-class citizens: their purple sign-in comes first,
       so they never read through the newcomer form (maintainer decision,
       revising UI-SUGGESTIONS #1). Newcomers get the full form right below. -->
  <button class="btn primary" onclick={() => (showExisting = !showExisting)}>
    <NostrichIcon size={20} />
    {t("login.alreadyOnNostr")}
  </button>

  {#if showExisting}
    <SignInOptions onSignedIn={done} />
  {/if}

  <div class="or-divider">{t("login.or")}</div>

  <div class="card">
    <h2>{t("login.createHeading")}</h2>
    <p class="muted">{t("login.createSub")}</p>
    <div class="row" style="gap:0.75rem;align-items:center;margin-bottom:0.5rem">
      <label style="cursor:pointer;flex:none;margin:0">
        {#if picPreview}
          <img src={picPreview} alt="" width="64" height="64" style="border-radius:50%;object-fit:cover" />
        {:else}
          <span style="display:flex;width:64px;height:64px;border-radius:50%;border:1px dashed var(--border);align-items:center;justify-content:center;color:var(--text-dim)"><Icon name="plus" size={22} /></span>
        {/if}
        <input type="file" accept="image/*" onchange={onPicFile} style="display:none" />
      </label>
      <div class="muted" style="font-size:0.85rem">{t("login.photoAdd")} <span class="badge">{t("login.photoPublic")}</span><br />{t("login.photoTap")}</div>
    </div>
    <label for="nm">{t("login.yourName")}</label>
    <input id="nm" bind:value={newName} placeholder={t("login.namePlaceholder")} />
    <button class="btn primary" style="margin-top:0.75rem" onclick={createNew} disabled={busy}>
      {busy ? t("login.creating") : t("login.createMyIdentity")}
    </button>
  </div>

{/if}
