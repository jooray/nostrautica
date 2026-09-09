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
  pickLatest,
  type PerEventSettings,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { VerifiedEvent } from "nostr-tools/pure";
import type { EventContext } from "./event-context.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyByAuthors } from "$lib/nostr/verify.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

// User-private per-event settings are decrypted with the user's self-key, so
// they cache under the OWNER scope (wiped on logout) and now survive reloads
// (CACHING-PLAN §2.8) — the People page paints want-to-meet/notes instantly.
function settingsKey(coordinate: string): string {
  return `evsettings:${coordinate}`;
}

/** Cached per-event settings for a coordinate (no network), or undefined. */
export function cachedPerEventSettings(coordinate: string): PerEventSettings | undefined {
  return cacheGet<PerEventSettings>(settingsKey(coordinate))?.data;
}

const EMPTY: PerEventSettings = {
  v: 2,
  favorites: [],
  want_to_meet: [],
  met: [],
  notes: {},
};

async function settingsD(signer: AppSigner, ctx: EventContext, blindingKey: Uint8Array): Promise<string> {
  const pubkey = await signer.getPublicKey();
  return `nostrautica:ev:${blindedD(blindingKey, ctx.coordinate, pubkey)}`;
}

/**
 * Load the user's private per-event settings, or the empty set when they have
 * never saved any.
 *
 * THROWS when a 30078 exists at this `d` but cannot be read (signer round-trip
 * failed, NIP-46 bunker timed out, ciphertext garbled). That is not the same
 * thing as "no notes yet", and this function used to answer both with EMPTY —
 * which was silently destructive, because every caller that writes
 * (`toggleSetting`, `setNote`) is a read-modify-write: one flaky `nip44Decrypt`
 * during a want-to-meet tap republished an EMPTY payload over the user's entire
 * private state for that event — every note, favourite and met marker gone, with
 * no error shown and nothing to restore from (the event is replaceable, and the
 * only copy was the one just overwritten). Callers that only READ may catch this
 * and fall back to `cachedPerEventSettings`; callers that write must not.
 */
export async function loadPerEventSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<PerEventSettings> {
  const pubkey = await signer.getPublicKey();
  const d = await settingsD(signer, ctx, blindingKey);
  const events = await fetchEvents({ kinds: [KIND_APP_DATA], authors: [pubkey], "#d": [d] });
  // Pin to the user's own key before the latest-wins pick. `authors` is a request
  // a relay may ignore, and with the refusal-to-write below in place an
  // undecryptable foreign 30078 at this `d` would be worse than noise — it would
  // be a wedge: one hostile event with a high created_at and the user could never
  // save a note again. Their own events are the only ones that can be self-decrypted
  // anyway, so pinning costs nothing and closes that off.
  const latest = pickLatest(onlyByAuthors(onlyVerified(events), [pubkey]));
  if (!latest) return { ...EMPTY };
  const json = await signer.nip44Decrypt(pubkey, latest.content);
  const settings = perEventSettingsSchema.parse(JSON.parse(json));
  cacheSet(settingsKey(ctx.coordinate), settings, latest.created_at ?? 0);
  return settings;
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
  // Monotonic (R6): kind-30078 is addressable by `d`; a same-second re-save
  // (toggle then note) must win the §3.1 tie-break rather than tie-and-lose.
  await publishMonotonic({
    kind: KIND_APP_DATA,
    author: pubkey,
    identifier: d,
    owner: pubkey,
    sign: (created_at) =>
      signer.signEvent({ kind: KIND_APP_DATA, created_at, tags: [["d", d]], content }) as Promise<VerifiedEvent>,
  });
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
  // Optimistic write-through (§2.8): the just-published settings are the newest.
  cacheSet(settingsKey(ctx.coordinate), settings, Math.floor(Date.now() / 1000));
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
  cacheSet(settingsKey(ctx.coordinate), settings, Math.floor(Date.now() / 1000));
  return settings;
}
