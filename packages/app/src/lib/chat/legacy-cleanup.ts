/**
 * Best-effort retirement of the v1 chat-device-key backup (NIP §7.5 migration).
 *
 * Wire v1 self-encrypted a remote-signer account's MLS device key as a per-user
 * kind-31602 entry (its `d` blinded over the literal "chat-device-key") so a second
 * browser could restore the SAME key. Wire v2 mints a per-DEVICE key for every
 * account type — there is nothing to restore, and that stale backup is a small
 * lingering secret-at-rest on the relays. On the first v2 chat session we NIP-09
 * delete it: fire-and-forget, gated by a once-per-account marker so it never runs
 * on later sessions and a relay that ignores NIP-09 costs us nothing.
 */
import { KIND_DELETION, KIND_MY_PROFILE, blindedDLiteral } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { deriveBlindingKey } from "$lib/events/blinding.js";
import { publishSigned } from "$lib/nostr/ndk.js";

/** The literal the v1 backup's `d` tag was blinded over (device-key-backup.ts). */
const DEVICE_KEY_LITERAL = "chat-device-key";

function markerKey(account: string): string {
  return `nostrautica:chat-legacy-backup-deleted:${account}`;
}
function alreadyDeleted(account: string): boolean {
  try {
    return localStorage.getItem(markerKey(account)) === "1";
  } catch {
    return false;
  }
}
function markDeleted(account: string): void {
  try {
    localStorage.setItem(markerKey(account), "1");
  } catch {
    /* storage unavailable — a re-attempt next session is harmless */
  }
}

/**
 * NIP-09-delete this account's legacy 31602 chat-device-key backup, once. The
 * addressable-deletion `a` tag (`31602:<account>:<blinded-d>`) targets exactly that
 * self-copy; nothing else this account authored under 31602 shares the blinded d.
 * Any failure is swallowed — this is hygiene, never a gate.
 *
 * Deliberately `publishSigned`, NOT `publishOrQueue`: this deletion's target may
 * never have existed at all (most accounts never had a v1 backup to retire), so a
 * failed attempt is not lost user data — nothing to durably retry or nag anyone
 * about. `publishOrQueue`'s fallback queues into the persistent outbox and surfaces
 * a user-facing "N couldn't be sent" indicator once retries are exhausted, which
 * turned a housekeeping no-op into a permanent, confusing red pill for anyone whose
 * first chat session hit an ordinary transient publish hiccup (confirmed 2026-08-04:
 * a multi-persona e2e run reproduced exactly this — a stuck kind-5 item nagging the
 * DM screens indefinitely, contradicting this function's own "swallowed" contract).
 */
export async function deleteLegacyChatDeviceKeyBackup(
  signer: AppSigner,
  relays?: string[],
): Promise<void> {
  const account = await signer.getPublicKey();
  if (alreadyDeleted(account)) return;
  try {
    const blindingKey = await deriveBlindingKey(signer);
    const d = blindedDLiteral(blindingKey, DEVICE_KEY_LITERAL);
    const deletion = await signer.signEvent({
      kind: KIND_DELETION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", `${KIND_MY_PROFILE}:${account}:${d}`],
        ["k", String(KIND_MY_PROFILE)],
      ],
      content: "retired chat device-key backup (wire v2)",
    });
    await publishSigned(deletion as unknown as Parameters<typeof publishSigned>[0], relays);
    // Only mark done once the deletion was actually accepted — a throw above
    // (signing OR publish) leaves the marker unset so the next session retries.
    markDeleted(account);
  } catch {
    /* best-effort — retried next session */
  }
}
