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
import { fetchEventsAnswered } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyByAuthors } from "$lib/nostr/verify.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { withMutationLock } from "$lib/nostr/mutation-lock.js";
import { cacheGet, cacheSet, cacheGeneration, activeCacheOwner } from "$lib/cache/persist.js";

/**
 * The cache scope a settings read or write runs FOR, captured when it starts
 * (the DS41-003 pattern). These calls await relays and the signer, and the
 * identity can change underneath them (logout, account switch): the decrypted
 * settings must be filed under the owner who read them, and dropped if the
 * owner cache was invalidated meanwhile, never written into the next account's
 * scope.
 */
interface CacheScope {
  owner: string | undefined;
  gen: number;
}

function captureScope(): CacheScope {
  return { owner: activeCacheOwner() ?? undefined, gen: cacheGeneration() };
}

function scopedGet(scope: CacheScope, key: string) {
  return scope.owner ? cacheGet<PerEventSettings>(key, scope.owner) : undefined;
}

function scopedSet(scope: CacheScope, key: string, data: PerEventSettings, at: number): void {
  if (scope.owner) cacheSet(key, data, at, scope.owner, scope.gen);
}

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

function empty(): PerEventSettings {
  return { v: 2, favorites: [], want_to_meet: [], met: [], notes: {} };
}

function clone(s: PerEventSettings): PerEventSettings {
  return JSON.parse(JSON.stringify(s)) as PerEventSettings;
}

async function settingsD(signer: AppSigner, ctx: EventContext, blindingKey: Uint8Array): Promise<string> {
  const pubkey = await signer.getPublicKey();
  return `nostrautica:ev:${blindedD(blindingKey, ctx.coordinate, pubkey)}`;
}

/**
 * Thrown by the WRITE path when nothing could be read: no event came back, no
 * relay answered, and this device holds no copy of its own. On the wire "no
 * answer" and "no settings" are the same empty array, and treating the first as
 * the second republished a 30078 holding only the change being made, over every
 * note, favourite and met marker the user had for the event (audit SB-01).
 */
export class SettingsUnreadableError extends Error {
  constructor() {
    super(
      "Couldn't read your saved notes for this event, so nothing was changed. " +
        "Check your connection and try again.",
    );
    this.name = "SettingsUnreadableError";
  }
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
 *
 * A read that comes back with nothing is answered from this device's own copy
 * when there is one, so a reader repaints the settings it last saw rather than a
 * blank list. The write path additionally refuses when there is no copy and no
 * relay answered (see {@link SettingsUnreadableError}).
 */
export async function loadPerEventSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<PerEventSettings> {
  return (await readSettings(signer, ctx, blindingKey, captureScope())).settings;
}

async function readSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  scope: CacheScope,
): Promise<{ settings: PerEventSettings; known: boolean }> {
  const pubkey = await signer.getPublicKey();
  const d = await settingsD(signer, ctx, blindingKey);
  const { events, answered } = await fetchEventsAnswered({
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [d],
  });
  // Pin to the user's own key before the latest-wins pick. `authors` is a request
  // a relay may ignore, and with the refusal-to-write below in place an
  // undecryptable foreign 30078 at this `d` would be worse than noise — it would
  // be a wedge: one hostile event with a high created_at and the user could never
  // save a note again. Their own events are the only ones that can be self-decrypted
  // anyway, so pinning costs nothing and closes that off.
  const latest = pickLatest(onlyByAuthors(onlyVerified(events), [pubkey]));
  const local = scopedGet(scope, settingsKey(ctx.coordinate));
  if (!latest) {
    // Nothing came back. A copy this device wrote (possibly still sitting in the
    // outbox) beats a blank either way. Without one, an answered read is a
    // genuine first save and an unanswered one is "unknown", not "empty".
    if (local) return { settings: clone(local.data), known: true };
    return { settings: empty(), known: answered };
  }
  const json = await signer.nip44Decrypt(pubkey, latest.content);
  const settings = perEventSettingsSchema.parse(JSON.parse(json));
  // A save from THIS device that has not reached the relays yet (queued offline)
  // is newer than what they returned; building the next save on the relay copy
  // would silently undo it.
  if (local && local.at > (latest.created_at ?? 0)) return { settings: clone(local.data), known: true };
  scopedSet(scope, settingsKey(ctx.coordinate), settings, latest.created_at ?? 0);
  return { settings, known: true };
}

/** Publish the whole settings document; returns the created_at it went out with. */
async function saveSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  settings: PerEventSettings,
): Promise<number> {
  const pubkey = await signer.getPublicKey();
  const d = await settingsD(signer, ctx, blindingKey);
  const content = await signer.nip44Encrypt(pubkey, JSON.stringify(settings));
  // Monotonic (R6): kind-30078 is addressable by `d`; a same-second re-save
  // (toggle then note) must win the §3.1 tie-break rather than tie-and-lose.
  const { createdAt } = await publishMonotonic({
    kind: KIND_APP_DATA,
    author: pubkey,
    identifier: d,
    owner: pubkey,
    sign: (created_at) =>
      signer.signEvent({ kind: KIND_APP_DATA, created_at, tags: [["d", d]], content }) as Promise<VerifiedEvent>,
  });
  return createdAt;
}

/**
 * Load → edit → publish one settings document under a per-document lock, so two
 * quick taps (or a toggle racing a note save) cannot both build on the same
 * baseline and erase each other (audit DS41-007). The read inside the lock is a
 * fresh one, so it also picks up a save another device made since the page
 * loaded; two devices writing within the same few seconds still need a real merge
 * on the wire (audit SB-88).
 */
async function mutateSettings(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  edit: (settings: PerEventSettings) => void,
): Promise<PerEventSettings> {
  const scope = captureScope();
  const pubkey = await signer.getPublicKey();
  const d = await settingsD(signer, ctx, blindingKey);
  return withMutationLock(`rmw:${pubkey}:${KIND_APP_DATA}:${d}`, async () => {
    const { settings, known } = await readSettings(signer, ctx, blindingKey, scope);
    if (!known) throw new SettingsUnreadableError();
    edit(settings);
    const createdAt = await saveSettings(signer, ctx, blindingKey, settings);
    // Write-through (§2.8), stamped with the created_at actually published so the
    // next read can tell this copy apart from an older relay answer.
    scopedSet(scope, settingsKey(ctx.coordinate), settings, createdAt);
    return settings;
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
  return mutateSettings(signer, ctx, blindingKey, (settings) => {
    settings[list] = toggle(settings[list], pubkey);
  });
}

/** Set (or clear) a private note about an attendee and persist. */
export async function setNote(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  pubkey: string,
  note: string,
): Promise<PerEventSettings> {
  return mutateSettings(signer, ctx, blindingKey, (settings) => {
    if (note.trim()) settings.notes[pubkey] = note.trim();
    else delete settings.notes[pubkey];
  });
}
