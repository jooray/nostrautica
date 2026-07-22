/**
 * Relay-published, self-encrypted backup of the MLS chat *device* key (Marmot
 * §9 Q1). A remote-signer (NIP-46/NIP-07) account's chat identity is a dedicated
 * device key held locally (see `identity.ts`). Without this, a second browser or
 * device signing in as the same account mints a DIFFERENT device key and joins
 * every MLS group as a stranger — silently forking the user's chat identity.
 *
 * The backup is a SIBLING of the cross-event intro-reuse library (`media/submit.ts`
 * `addToLibrary`): a single per-user kind-31602 entry, `a:null`, self-encrypted via
 * NIP-44 to the account's OWN pubkey, its `d` blinded over the literal
 * "chat-device-key" (not an event coordinate) so it is genuinely cross-device /
 * cross-event. It carries ONLY the 32-byte key — no group/epoch state (which is
 * non-transferable between devices anyway per Marmot), no coordinate, nothing else.
 *
 * Security: the blob is NIP-44 self-encrypted, so only the account's own signer can
 * decrypt it. It can let a device *restore* the existing identity, but can never
 * add or impersonate a device without that signer — the same guarantee the local
 * lock/unlock flow already relies on. This module is purely relay I/O; all
 * orchestration (local persistence, mint-vs-restore, the idempotency marker, and
 * composition with the local-lock fail-closed path) lives in `identity.ts`.
 */
import { getPublicKey } from "nostr-tools/pure";
import {
  KIND_MY_PROFILE,
  blindedDLiteral,
  bytesToBase64,
  base64ToBytes,
  chatDeviceKeyBackupSchema,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { deriveBlindingKey } from "$lib/events/blinding.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

/** The literal the device-key backup's `d` tag is blinded over (a SIBLING of the
 *  "library" reuse entry under the same kind, distinct `d` — never collides). */
const DEVICE_KEY_LITERAL = "chat-device-key";

/**
 * Fetch + decrypt this account's relay-published chat device-key backup, or
 * undefined when none exists (a first-ever device) or it can't be decrypted (the
 * signer is unavailable). Never throws for the "absent" case; a failed decrypt or
 * a malformed/hostile payload rejects so the caller can decide (identity.ts treats
 * any failure as "no usable backup" and falls through to its fail-closed/mint path).
 */
export async function fetchChatDeviceKeyBackup(
  signer: AppSigner,
): Promise<Uint8Array | undefined> {
  const account = await signer.getPublicKey();
  const blindingKey = await deriveBlindingKey(signer);
  const d = blindedDLiteral(blindingKey, DEVICE_KEY_LITERAL);
  const events = await fetchEvents({
    kinds: [KIND_MY_PROFILE],
    authors: [account],
    "#d": [d],
  });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return undefined;
  const json = await signer.nip44Decrypt(account, latest.content);
  // Validate at the boundary (.strict schema): a device key and nothing else.
  const parsed = chatDeviceKeyBackupSchema.parse(JSON.parse(json));
  const key = base64ToBytes(parsed.chat_device_key);
  return key.length === 32 ? new Uint8Array(key) : undefined;
}

/**
 * Publish (or refresh) the self-encrypted device-key backup. Always writes — the
 * caller gates on an idempotency marker so this doesn't run on every chat open.
 * The event is authored by the ACCOUNT (via `signer.signEvent`) and encrypted to
 * the account's own pubkey, exactly like the reuse-library entry.
 */
export async function publishChatDeviceKeyBackup(
  signer: AppSigner,
  deviceKey: Uint8Array,
): Promise<void> {
  const account = await signer.getPublicKey();
  const blindingKey = await deriveBlindingKey(signer);
  const d = blindedDLiteral(blindingKey, DEVICE_KEY_LITERAL);
  const content = {
    v: 1,
    a: null,
    chat_device_key: bytesToBase64(new Uint8Array(deviceKey)),
  };
  const cipher = await signer.nip44Encrypt(account, JSON.stringify(content));
  const event = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", d]],
    content: cipher,
  });
  await publishOrQueue(event);
}

/** The chat pubkey a device key maps to — used for the idempotency marker. */
export function chatPubkeyOf(deviceKey: Uint8Array): string {
  return getPublicKey(deviceKey);
}
