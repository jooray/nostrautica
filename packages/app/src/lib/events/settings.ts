/**
 * User-private per-event settings (spec §7.3): favorites, want-to-meet, met, and
 * notes, stored in a NIP-44 self-encrypted kind-30078 event with
 * `d = "nostrautica:ev:<blinded>"`. Invisible to everyone, including the
 * coordinator (user-private tier, §4.1).
 */
import {
  KIND_APP_DATA,
  blindedD,
  perEventSettingsSchema,
  type PerEventSettings,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

const EMPTY: PerEventSettings = {
  v: 1,
  favorites: [],
  want_to_meet: [],
  met: [],
  notes: {},
};

async function settingsD(signer: AppSigner, ctx: EventContext, blindingKey: Uint8Array): Promise<string> {
  const pubkey = await signer.getPublicKey();
  return `nostrautica:ev:${blindedD(blindingKey, ctx.coordinate, pubkey)}`;
}

export async function loadPerEventSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<PerEventSettings> {
  const pubkey = await signer.getPublicKey();
  const d = await settingsD(signer, ctx, blindingKey);
  const events = await fetchEvents({ kinds: [KIND_APP_DATA], authors: [pubkey], "#d": [d] });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return { ...EMPTY };
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    return perEventSettingsSchema.parse(JSON.parse(json));
  } catch {
    return { ...EMPTY };
  }
}

async function saveSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  settings: PerEventSettings,
): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const d = await settingsD(signer, ctx, blindingKey);
  const content = await signer.nip44Encrypt(pubkey, JSON.stringify(settings));
  const event = await signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", d]],
    content,
  });
  await publishOrQueue(event);
}

function toggle(list: string[], pubkey: string): string[] {
  return list.includes(pubkey) ? list.filter((x) => x !== pubkey) : [...list, pubkey];
}

export type SettingList = "favorites" | "want_to_meet" | "met";

/** Toggle a pubkey in one of the list-type settings and persist. */
export async function toggleSetting(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  list: SettingList,
  pubkey: string,
): Promise<PerEventSettings> {
  const settings = await loadPerEventSettings(signer, ctx, blindingKey);
  settings[list] = toggle(settings[list], pubkey);
  await saveSettings(signer, ctx, blindingKey, settings);
  return settings;
}

/** Set (or clear) a private note about an attendee and persist. */
export async function setNote(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  pubkey: string,
  note: string,
): Promise<PerEventSettings> {
  const settings = await loadPerEventSettings(signer, ctx, blindingKey);
  if (note.trim()) settings.notes[pubkey] = note.trim();
  else delete settings.notes[pubkey];
  await saveSettings(signer, ctx, blindingKey, settings);
  return settings;
}
