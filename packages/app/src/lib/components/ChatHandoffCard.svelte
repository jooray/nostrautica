<script lang="ts">
  // "Chat devices" management (NIP §10 multi-device).
  //
  // Under per-device keys each browser/device mints and attests its own chat key
  // (attest.ts / NIP §10.2), joining the group on its own. This card lists the
  // account's attested devices for THIS event (from the ECK roster's chat_keys),
  // lets the user rename THIS device's label (re-attest with proof of possession),
  // and revoke any device (21607 op:revoke, sealed by the account key — no proof
  // needed). Renaming another device is impossible by design: only the holder of a
  // device's secret can produce its proof of possession, so "rename" is offered for
  // this device alone.
  import { onMount } from "svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { enterSecretSurface } from "$lib/stores/secret-surface.svelte.js";
  import { chatSession } from "$lib/chat/session.svelte.js";
  import { fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import { sendChatKeyAttestation } from "$lib/chat/attest.js";
  import { devicesForAccount } from "$lib/chat/members.js";
  import type { EventContext } from "$lib/events/event-context.js";
  import Icon from "$lib/components/icons/Icon.svelte";

  let { ctx }: { ctx: EventContext } = $props();

  // §13.3: chat device handoff/management is a sensitive per-device surface;
  // suppress the event theme while it's shown (it renders on the themed Chat
  // route) so no organizer CSS is live over device identity/management controls.
  onMount(() => enterSecretSurface());

  const account = $derived(session.pubkey);
  const myChatPubkey = $derived(chatSession.chatPubkey);

  type Device = { pubkey: string; label?: string; added_at: number };
  let devices = $state<Device[]>([]);
  let loading = $state(true);
  // Per-device inline UI state (rename input / revoke confirm / in-flight).
  let renaming = $state<string | null>(null);
  let renameDraft = $state("");
  let confirmingRevoke = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let notice = $state<string | null>(null);

  function loadFromCache(): void {
    if (!account) return;
    devices = devicesForAccount(cachedRoster(ctx.coordinate), account);
  }

  async function refresh(): Promise<void> {
    if (!account) return;
    const roster = await fetchRoster(ctx).catch(() => cachedRoster(ctx.coordinate));
    devices = devicesForAccount(roster, account);
  }

  $effect(() => {
    // Re-derive when the account or event changes.
    void account;
    void ctx.coordinate;
    loading = true;
    loadFromCache();
    void refresh().finally(() => (loading = false));
  });

  function labelFor(d: Device): string {
    return d.label?.trim() || d.pubkey.slice(0, 12) + "…";
  }
  function addedLabel(d: Device): string {
    try {
      return t("chat.devices.added", { date: new Date(d.added_at * 1000).toLocaleDateString() });
    } catch {
      return "";
    }
  }

  function startRename(d: Device): void {
    renaming = d.pubkey;
    renameDraft = d.label ?? "";
    confirmingRevoke = null;
  }

  async function saveRename(d: Device): Promise<void> {
    const label = renameDraft.trim();
    if (!label || !session.signer) return;
    busy = d.pubkey;
    notice = null;
    try {
      // Re-attesting THIS device needs its secret to sign the §10.2 proof — resolve
      // it lazily (pulls the marmot bundle only when the user actually renames).
      const { resolveChatIdentity } = await import("$lib/chat/identity.js");
      const id = await resolveChatIdentity(session.signer);
      await sendChatKeyAttestation(session.signer, ctx, {
        op: "add",
        chatPubkey: id.pubkey,
        clientId: id.clientId,
        label,
        deviceSecretKey: id.secretKey,
      });
      // Optimistic: reflect the new label locally; the roster catches up shortly.
      devices = devices.map((x) => (x.pubkey === d.pubkey ? { ...x, label } : x));
      notice = t("chat.devices.updated");
      renaming = null;
    } catch {
      notice = t("chat.devices.actionFailed");
    } finally {
      busy = null;
      setTimeout(() => void refresh(), 4000);
    }
  }

  async function doRevoke(d: Device): Promise<void> {
    if (!session.signer) return;
    busy = d.pubkey;
    notice = null;
    try {
      await sendChatKeyAttestation(session.signer, ctx, { op: "revoke", chatPubkey: d.pubkey });
      // Optimistic removal; the coordinator removes the leaf and republishes.
      devices = devices.filter((x) => x.pubkey !== d.pubkey);
      notice = t("chat.devices.updated");
      confirmingRevoke = null;
    } catch {
      notice = t("chat.devices.actionFailed");
    } finally {
      busy = null;
      setTimeout(() => void refresh(), 4000);
    }
  }
</script>

<section class="handoff card" aria-label={t("chat.devices.manage.title")}>
  <strong>{t("chat.devices.manage.title")}</strong>
  <p class="muted">{t("chat.devices.manage.body")}</p>

  {#if loading && devices.length === 0}
    <p class="muted small">{t("chat.devices.loading")}</p>
  {:else if devices.length === 0}
    <p class="muted small">{t("chat.devices.none")}</p>
  {:else}
    <ul class="devices">
      {#each devices as d (d.pubkey)}
        {@const isThis = d.pubkey === myChatPubkey}
        <li class="device">
          <div class="row">
            <Icon name="waypoint" size={18} />
            <div class="meta">
              {#if renaming === d.pubkey}
                <input
                  class="rename-input"
                  bind:value={renameDraft}
                  maxlength="60"
                  aria-label={t("chat.devices.renameLabel")}
                  onkeydown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void saveRename(d); }
                    if (e.key === "Escape") renaming = null;
                  }}
                />
              {:else}
                <span class="name">{labelFor(d)}</span>
                {#if isThis}<span class="badge-you">{t("chat.devices.thisDevice")}</span>{/if}
                <span class="added">{addedLabel(d)}</span>
              {/if}
            </div>
          </div>

          <div class="actions">
            {#if renaming === d.pubkey}
              <button class="btn inline" disabled={!renameDraft.trim() || busy === d.pubkey} onclick={() => void saveRename(d)}>
                {t("chat.devices.renameSave")}
              </button>
              <button class="btn inline ghost" onclick={() => (renaming = null)}>{t("chat.devices.renameCancel")}</button>
            {:else if confirmingRevoke === d.pubkey}
              <span class="confirm-q">{t("chat.devices.revokeConfirm")}</span>
              <button class="btn inline danger" disabled={busy === d.pubkey} onclick={() => void doRevoke(d)}>
                {t("chat.devices.revokeYes")}
              </button>
              <button class="btn inline ghost" onclick={() => (confirmingRevoke = null)}>{t("chat.devices.revokeNo")}</button>
            {:else}
              {#if isThis}
                <button class="btn inline ghost" disabled={busy === d.pubkey} onclick={() => startRename(d)}>
                  {t("chat.devices.rename")}
                </button>
              {/if}
              <button class="btn inline ghost danger" disabled={busy === d.pubkey} onclick={() => (confirmingRevoke = d.pubkey)}>
                {t("chat.devices.revoke")}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if notice}<p class="muted small notice" role="status">{notice}</p>{/if}
</section>

<style>
  .handoff {
    margin-top: 1.25rem;
  }
  .small {
    font-size: 0.82rem;
  }
  .devices {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .device {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-raised) 40%, transparent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem;
    min-width: 0;
  }
  .name {
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .badge-you {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
  }
  .added {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .confirm-q {
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .rename-input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    font: inherit;
    background: var(--bg-raised);
    color: var(--text);
    min-width: 10rem;
  }
  .btn.inline.ghost {
    background: transparent;
  }
  .btn.inline.danger {
    color: var(--danger);
  }
  .notice {
    margin-top: 0.5rem;
  }
</style>
