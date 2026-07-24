/**
 * Nostrautica cryptography (spec §6). Pure, runtime-agnostic: works in the browser
 * (WebCrypto) and in Node (node:crypto webcrypto) through `globalThis.crypto`.
 *
 * No bespoke crypto: symmetric confidentiality reuses the audited NIP-44 v2
 * construction (ChaCha20 + HMAC-SHA256, padded) from nostr-tools; media uses
 * WebCrypto AES-256-GCM; signatures use @noble/curves schnorr.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import {
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
} from "@noble/hashes/utils";
import { v2 as nip44v2, getConversationKey } from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";

// ── Base64 helpers (runtime-agnostic) ────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // btoa exists in browsers; Buffer in Node. Prefer btoa, fall back to Buffer.
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ── ECK: the outbound symmetric layer (spec §6.3) ────────────────────────────
// "Encrypted under ECK" = NIP-44 v2, using the 32-byte ECK *directly* as the
// conversation key (no ECDH). Audited primitive, no bespoke crypto.

/** Generate a fresh 32-byte Event Content Key. */
export function generateEck(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// Classic NIP-44 v2 caps a payload at 65,535 plaintext bytes (spec §7.4).
// Newer nostr-tools accepts larger extended-prefix payloads, but emitting one
// would break every classic NIP-44 decrypter — enforce the ceiling at every
// encrypt entry point (audit PROTO-3). Module-private: event-page.ts already
// exports a NIP44_MAX_PLAINTEXT_BYTES for the public API.
const NIP44_MAX_PLAINTEXT_BYTES = 65_535;

function assertNip44Ceiling(plaintext: string): void {
  const bytes = utf8ToBytes(plaintext).length;
  if (bytes > NIP44_MAX_PLAINTEXT_BYTES) {
    throw new Error(
      `NIP-44 plaintext is ${bytes} bytes — the ceiling is 65535`,
    );
  }
}

// Decrypt-side ceiling (audit P10). Encryption caps plaintext at 65,535 bytes,
// but decrypt handed the base64 payload straight to the dependency, which
// base64-decodes and allocates before deciding it's too large. Reject an
// over-length ciphertext BEFORE that, derived precisely from the NIP-44 v2
// payload layout for the largest legal plaintext:
//   padded region = 2-byte length prefix + calcPaddedLen(65535) padding bytes
//   raw payload   = 1 version byte + 32-byte nonce + padded region + 32-byte MAC
//   base64        = ceil(raw / 3) * 4   (no wasted padding at this length)
// which is 87,472 chars. Anything longer cannot be a valid classic NIP-44 v2
// payload of a within-ceiling plaintext, so it is rejected without decoding.
const NIP44_MAX_CIPHERTEXT_B64 =
  Math.ceil(
    (1 + 32 + (2 + nip44v2.utils.calcPaddedLen(NIP44_MAX_PLAINTEXT_BYTES)) + 32) / 3,
  ) * 4;

function assertNip44CiphertextCeiling(ciphertext: string): void {
  if (ciphertext.length > NIP44_MAX_CIPHERTEXT_B64) {
    throw new Error(
      `NIP-44 ciphertext is ${ciphertext.length} base64 chars — the ceiling is ${NIP44_MAX_CIPHERTEXT_B64}`,
    );
  }
}

export function eckEncrypt(eck: Uint8Array, plaintext: string): string {
  if (eck.length !== 32) throw new Error("ECK must be 32 bytes");
  assertNip44Ceiling(plaintext);
  return nip44v2.encrypt(plaintext, eck);
}

export function eckDecrypt(eck: Uint8Array, ciphertext: string): string {
  if (eck.length !== 32) throw new Error("ECK must be 32 bytes");
  assertNip44CiphertextCeiling(ciphertext);
  return nip44v2.decrypt(ciphertext, eck);
}

// ── NIP-44 directed encryption (pair-encrypted, inbound to E_inbox) ───────────

/** NIP-44 v2 encrypt from `senderSk` to `recipientPubkey` (both hex/bytes). */
export function nip44Encrypt(
  senderSk: Uint8Array,
  recipientPubkey: string,
  plaintext: string,
): string {
  assertNip44Ceiling(plaintext);
  const convKey = getConversationKey(senderSk, recipientPubkey);
  return nip44v2.encrypt(plaintext, convKey);
}

export function nip44Decrypt(
  recipientSk: Uint8Array,
  senderPubkey: string,
  ciphertext: string,
): string {
  assertNip44CiphertextCeiling(ciphertext);
  const convKey = getConversationKey(recipientSk, senderPubkey);
  return nip44v2.decrypt(ciphertext, convKey);
}

// ── NIP-44 self-encryption (user-private tier, spec §4.1) ────────────────────

/** The NIP-44 conversation key of a key with itself (used for self-stores). */
export function selfConversationKey(sk: Uint8Array): Uint8Array {
  return getConversationKey(sk, getPublicKey(sk));
}

export function selfEncrypt(sk: Uint8Array, plaintext: string): string {
  assertNip44Ceiling(plaintext);
  return nip44v2.encrypt(plaintext, selfConversationKey(sk));
}

export function selfDecrypt(sk: Uint8Array, ciphertext: string): string {
  assertNip44CiphertextCeiling(ciphertext);
  return nip44v2.decrypt(ciphertext, selfConversationKey(sk));
}

// ── Blinded d-tags (spec §6.6) ───────────────────────────────────────────────
// d = hex( hmac_sha256(key, message) )[0..32]  → first 32 hex chars (16 bytes)

function blindedDFromMessage(key: Uint8Array, message: string): string {
  const mac = hmac(sha256, key, utf8ToBytes(message));
  return bytesToHex(mac).slice(0, 32);
}

/**
 * Blinded d-tag for a per-attendee addressable event.
 * `key` = the self-conversation-key (31602) or the current ECK (31603/31605).
 */
export function blindedD(
  key: Uint8Array,
  coordinate: string,
  attendeePubkey: string,
): string {
  return blindedDFromMessage(key, `${coordinate}|${attendeePubkey}`);
}

/** Blinded d-tag over a literal string, e.g. the reuse-library entry ("library"). */
export function blindedDLiteral(key: Uint8Array, literal: string): string {
  return blindedDFromMessage(key, literal);
}

// ── AES-256-GCM media encryption (spec §6.2) ─────────────────────────────────
// Fresh 32-byte key + 12-byte IV per blob, single-shot (whole-file). No range
// playback (documented v1 limitation). Same code path in browser + Node.

export interface MediaCipher {
  ciphertext: Uint8Array;
  key: Uint8Array; // 32 bytes
  nonce: Uint8Array; // 12 bytes
}

export async function aesGcmEncrypt(
  plaintext: Uint8Array,
  key?: Uint8Array,
  nonce?: Uint8Array,
): Promise<MediaCipher> {
  const k = key ?? crypto.getRandomValues(new Uint8Array(32));
  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (k.length !== 32) throw new Error("AES-GCM key must be 32 bytes");
  if (iv.length !== 12) throw new Error("AES-GCM nonce must be 12 bytes");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    k as unknown as ArrayBuffer & Uint8Array,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    plaintext as BufferSource,
  );
  return { ciphertext: new Uint8Array(ct), key: k, nonce: iv };
}

export async function aesGcmDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer & Uint8Array,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    cryptoKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}

/** sha256 of a byte buffer as lowercase hex — used for Blossom addressing (x/ox). */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

// ── Invite proofs (NIP §7) ───────────────────────────────────────────────────
// An invite code IS an nsec. Proof = BIP-340 schnorr signature by the invite key
// over a domain-separated, injectively-encoded challenge (wire v2):
//
//   sha256( utf8( JSON.stringify(
//     ["nostrautica-invite-v2", <coordinate>, <attendee-pubkey-hex>] ) ) )
//
// The literal first element is the domain-separation tag; JSON-array encoding is
// injective, fixing v1's ambiguous `"<coordinate>:<attendee>"` colon-join (the
// coordinate itself contains colons). A v1-format proof necessarily fails against
// this challenge — the digest differs — so v1 proofs are rejected on the flag day.
const INVITE_PROOF_TAG = "nostrautica-invite-v2";

function inviteChallenge(coordinate: string, attendeePubkey: string): Uint8Array {
  return sha256(
    utf8ToBytes(JSON.stringify([INVITE_PROOF_TAG, coordinate, attendeePubkey])),
  );
}

/** sha256(invite-pubkey) hex — what the organizer publishes in kind 31601. */
export function inviteHash(invitePubkeyHex: string): string {
  return bytesToHex(sha256(hexToBytes(invitePubkeyHex)));
}

export interface InviteProof {
  invitePubkey: string; // hex
  sig: string; // hex schnorr sig
}

export function makeInviteProof(
  inviteSk: Uint8Array,
  coordinate: string,
  attendeePubkey: string,
): InviteProof {
  const invitePubkey = getPublicKey(inviteSk);
  const sig = schnorr.sign(inviteChallenge(coordinate, attendeePubkey), inviteSk);
  return { invitePubkey, sig: bytesToHex(sig) };
}

export function verifyInviteProof(
  proof: InviteProof,
  coordinate: string,
  attendeePubkey: string,
): boolean {
  try {
    return schnorr.verify(
      hexToBytes(proof.sig),
      inviteChallenge(coordinate, attendeePubkey),
      proof.invitePubkey,
    );
  } catch {
    return false;
  }
}

/**
 * Stateless invite verification (spec §6.5): the proof's invite pubkey must hash
 * into the published 31601 set AND the signature must bind this attendee.
 *
 * This is a predicate over UNTRUSTED input (anyone can gift-wrap a 21600 join
 * request to the public E_inbox), so malformed proof fields must return false,
 * never throw — `inviteHash`'s hexToBytes would otherwise throw on a non-hex
 * invite pubkey (audit PROTO-1).
 */
export function isInviteValid(
  proof: InviteProof,
  publishedHashes: ReadonlySet<string>,
  coordinate: string,
  attendeePubkey: string,
): boolean {
  if (
    !/^[0-9a-f]{64}$/.test(proof.invitePubkey) ||
    !/^[0-9a-f]{128}$/.test(proof.sig)
  ) {
    return false;
  }
  return (
    publishedHashes.has(inviteHash(proof.invitePubkey)) &&
    verifyInviteProof(proof, coordinate, attendeePubkey)
  );
}

// ── Chat device attestation proof of possession (NIP §10.2) ──────────────────
// A 21607 v2 `op:"add"` attestation is sealed by the ACCOUNT key but must ALSO
// prove the account controls the chat DEVICE key's secret — otherwise an account
// could attest a chat pubkey it doesn't own (v1's griefing/mis-binding gap). The
// device key signs a domain-separated, injective challenge that also binds the
// rumor's `created_at`, so a captured proof can't be replayed under a different
// timestamp/rumor:
//
//   sha256( utf8( JSON.stringify(
//     ["nostrautica-chat-device-v2", <coordinate>, <account-pubkey>,
//      <chat-pubkey>, <created_at>] ) ) )
const CHAT_DEVICE_PROOF_TAG = "nostrautica-chat-device-v2";

function chatDeviceChallenge(
  coordinate: string,
  accountPubkey: string,
  chatPubkey: string,
  createdAt: number,
): Uint8Array {
  return sha256(
    utf8ToBytes(
      JSON.stringify([
        CHAT_DEVICE_PROOF_TAG,
        coordinate,
        accountPubkey,
        chatPubkey,
        createdAt,
      ]),
    ),
  );
}

/**
 * Build a chat-device proof of possession: BIP-340 schnorr signature by the chat
 * DEVICE key over the §10.2 challenge. `createdAt` MUST be the 21607 rumor's own
 * `created_at` (the verifier reconstructs the challenge from it). Returns hex.
 */
export function makeChatDeviceProof(
  deviceSk: Uint8Array,
  coordinate: string,
  accountPubkey: string,
  createdAt: number,
): string {
  const chatPubkey = getPublicKey(deviceSk);
  const sig = schnorr.sign(
    chatDeviceChallenge(coordinate, accountPubkey, chatPubkey, createdAt),
    deviceSk,
  );
  return bytesToHex(sig);
}

/**
 * Verify a chat-device proof of possession (NIP §10.2). A predicate over
 * UNTRUSTED input (the coordinator receives it inside a gift-wrapped rumor from
 * anyone) — malformed hex must return false, never throw. Returns true only when
 * `proofSig` is a valid BIP-340 signature by `chatPubkey` over the challenge that
 * binds this (coordinate, account, chat pubkey, created_at).
 */
export function verifyChatDeviceProof(
  proofSig: string,
  coordinate: string,
  accountPubkey: string,
  chatPubkey: string,
  createdAt: number,
): boolean {
  if (!/^[0-9a-f]{128}$/.test(proofSig) || !/^[0-9a-f]{64}$/.test(chatPubkey)) {
    return false;
  }
  try {
    return schnorr.verify(
      hexToBytes(proofSig),
      chatDeviceChallenge(coordinate, accountPubkey, chatPubkey, createdAt),
      chatPubkey,
    );
  } catch {
    return false;
  }
}

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes };
