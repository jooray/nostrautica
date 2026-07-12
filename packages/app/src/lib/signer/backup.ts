/**
 * Key backup & import helpers (spec §5.2, §5.4). Pure functions (no DOM) so they
 * can be unit-tested; the UI layer wires them to buttons and the clipboard.
 *
 * Backup options offered after registration:
 *  - Email-to-self: a `mailto:` link carrying the app URL with the nsec in the
 *    URL *fragment* (never reaches a server). The UI must state plainly that
 *    email is not confidential transport.
 *  - NIP-49 export: password-encrypted `ncryptsec` (scrypt + XChaCha20-Poly1305).
 *  - Raw nsec copy (with a warning), for pasting into other Nostr clients.
 */
import { nsecEncode, decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { encrypt as nip49Encrypt, decrypt as nip49Decrypt } from "nostr-tools/nip49";

/** Encode a 32-byte secret key as an nsec (bech32). */
export function toNsec(sk: Uint8Array): string {
  return nsecEncode(sk);
}

/** Decode an nsec into raw 32-byte secret key. Throws on anything else. */
export function fromNsec(nsec: string): Uint8Array {
  const decoded = decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("Not an nsec");
  return decoded.data;
}

/** True if the string looks like an ncryptsec (NIP-49 password-encrypted key). */
export function isNcryptsec(s: string): boolean {
  return s.trim().startsWith("ncryptsec1");
}

/** Encrypt a secret key with a passphrase → ncryptsec (NIP-49). */
export function toNcryptsec(sk: Uint8Array, passphrase: string): string {
  if (!passphrase) throw new Error("passphrase required");
  return nip49Encrypt(sk, passphrase);
}

/** Decrypt an ncryptsec with its passphrase → raw secret key (NIP-49). */
export function fromNcryptsec(ncryptsec: string, passphrase: string): Uint8Array {
  return nip49Decrypt(ncryptsec.trim(), passphrase);
}

/** The app-URL login link that carries an nsec in the fragment (spec §5.2). */
export function loginLink(appBaseUrl: string, sk: Uint8Array): string {
  const base = appBaseUrl.replace(/[#/]+$/, "");
  return `${base}/#/login?nsec=${toNsec(sk)}`;
}

/** A `mailto:` backup link (subject + body containing the login link). */
export function mailtoBackup(appBaseUrl: string, sk: Uint8Array): string {
  const link = loginLink(appBaseUrl, sk);
  const subject = encodeURIComponent("Your Nostrautica key");
  const body = encodeURIComponent(
    [
      "This link logs you back into Nostrautica on any device.",
      "Keep this email private — anyone with this link controls your account.",
      "",
      link,
      "",
      "(Email is not confidential transport. This is a convenience trade-off",
      "against losing access to your identity.)",
    ].join("\n"),
  );
  return `mailto:?subject=${subject}&body=${body}`;
}

/**
 * Interpret any credential a user might paste at login: nsec, ncryptsec (needs
 * passphrase), or a raw 64-char hex secret key. Returns the 32-byte secret key.
 */
export function importCredential(input: string, passphrase?: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith("nsec1")) return fromNsec(s);
  if (isNcryptsec(s)) {
    if (!passphrase) throw new Error("passphrase required for ncryptsec");
    return fromNcryptsec(s, passphrase);
  }
  if (/^[0-9a-f]{64}$/i.test(s)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  throw new Error("Unrecognized key format");
}

/** npub-independent sanity check that a key is usable. */
export function pubkeyFromSk(sk: Uint8Array): string {
  return getPublicKey(sk);
}
