/**
 * NIP-59 gift-wrap helpers (spec §7.2), typed per Nostrautica rumor kind.
 *
 * Mechanics (per NIP-59): rumor (unsigned) → seal kind 13 (NIP-44, signed by the
 * true author, empty tags) → wrap kind 1059 (random one-time key, single `p` tag =
 * recipient, `created_at` randomized up to 2 days in the past).
 *
 * Consumers must subscribe with `since = now − 3 days` (timestamp randomization
 * overlap) and dedupe by rumor id — see `giftwrapSince`.
 */
import { wrapEvent } from "nostr-tools/nip59";
import { getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/pure";
import type { RumorKind } from "./kinds.js";
import { KIND_GIFT_WRAP, KIND_SEAL } from "./kinds.js";
import { nip44Decrypt } from "./crypto.js";

/**
 * Clock-skew allowance when clamping rumor timestamps (audit PROTO-8). Invite
 * approval is first-come (single-use) and 31601 replacement is latest-wins, and
 * both order by `created_at` — but a rumor's timestamp is unauthenticated, so a
 * future-dated rumor must gain no ordering advantage: unwrap clamps it to at
 * most now + this allowance. 15 minutes covers honest clock skew.
 */
export const RUMOR_MAX_CLOCK_SKEW_SEC = 15 * 60;

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64_SIG = /^[0-9a-f]{128}$/;

/**
 * Structural validation of a just-decrypted rumor (audit PROTO-2): a hand-rolled
 * seal can omit/mistype any field, and the old unchecked cast crashed downstream
 * consumers (e.g. a missing `tags` TypeErrors in `rumor.tags.find`). Reject
 * anything that isn't a well-formed unsigned event before it crosses the unwrap
 * boundary.
 */
function assertRumorShape(raw: unknown): asserts raw is Rumor {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("rumor is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !HEX32.test(r.id)) {
    throw new Error("rumor id is not 64-char lowercase hex");
  }
  if (typeof r.pubkey !== "string" || !HEX32.test(r.pubkey)) {
    throw new Error("rumor pubkey is not 64-char lowercase hex");
  }
  if (typeof r.kind !== "number" || !Number.isInteger(r.kind) || r.kind < 0) {
    throw new Error("rumor kind is not a non-negative integer");
  }
  if (typeof r.created_at !== "number" || !Number.isFinite(r.created_at)) {
    throw new Error("rumor created_at is not a finite number");
  }
  if (
    !Array.isArray(r.tags) ||
    !r.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"))
  ) {
    throw new Error("rumor tags are not an array of string arrays");
  }
  if (typeof r.content !== "string") {
    throw new Error("rumor content is not a string");
  }
}

/** An unsigned rumor event (has id + pubkey, never a signature). */
export interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** A signed NIP-59 gift wrap (kind 1059). */
export interface GiftWrap {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A signed NIP-59 seal (kind 13, empty tags) whose author is verified. */
export interface Seal {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Verify a just-decrypted seal (audit P1). Successful NIP-44 decryption does NOT
 * authenticate the seal's author: ECDH gives both parties the same conversation
 * key, so a holder of `recipientSk` can encrypt a seal under the key derived from
 * `recipientSk` and ANY claimed sender pubkey. Only the kind-13 Schnorr signature
 * proves who authored the seal — and downstream authorization (21603/21604 admin
 * commands, 21600/21601/21608/21609/21610 attendee actions) trusts the resulting
 * `rumor.pubkey` as an authenticated identity. So the seal must be a complete,
 * signed kind-13 event with empty tags whose id hashes its contents and whose
 * signature verifies, BEFORE its content is decrypted.
 */
export function assertVerifiedSeal(raw: unknown): asserts raw is Seal {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("seal is not an object");
  }
  const s = raw as Record<string, unknown>;
  if (s.kind !== KIND_SEAL) {
    throw new Error(`inner event is not a seal (kind ${String(s.kind)})`);
  }
  if (typeof s.pubkey !== "string" || !HEX32.test(s.pubkey)) {
    throw new Error("seal pubkey is not 64-char lowercase hex");
  }
  if (typeof s.id !== "string" || !HEX32.test(s.id)) {
    throw new Error("seal id is not 64-char lowercase hex");
  }
  if (typeof s.sig !== "string" || !HEX64_SIG.test(s.sig)) {
    throw new Error("seal sig is not 128-char lowercase hex");
  }
  if (typeof s.created_at !== "number" || !Number.isFinite(s.created_at)) {
    throw new Error("seal created_at is not a finite number");
  }
  if (typeof s.content !== "string") {
    throw new Error("seal content is not a string");
  }
  // NIP-59 requires the seal to carry no tags; a non-empty set is malformed and
  // must never reach signature verification as if it were a legitimate seal.
  if (!Array.isArray(s.tags) || s.tags.length !== 0) {
    throw new Error("seal tags must be empty (NIP-59)");
  }
  // Recompute the id and verify the Schnorr signature — this, not decryption, is
  // what authenticates s.pubkey as the seal author.
  if (!verifyEvent(s as unknown as NostrEvent)) {
    throw new Error("seal signature is invalid");
  }
}

/**
 * A validated rumor together with the effective timestamp local ordering policy
 * should use (audit R19). `rumor` is the ORIGINAL, authenticated event: every
 * field is exactly what the seal author signed, so `rumor.id` still hashes its
 * contents and stays a stable dedupe key. `effectiveCreatedAt` is `rumor.created_at`
 * clamped to at most now + {@link RUMOR_MAX_CLOCK_SKEW_SEC} (PROTO-8) — a separate
 * value a caller may use for first-come/latest-wins ordering WITHOUT mutating the
 * authenticated rumor. This keeps ordering from being processing-time-dependent on
 * the authenticated object and lets independent unwrappers agree on the rumor's id.
 */
export interface UnwrappedRumor {
  rumor: Rumor;
  effectiveCreatedAt: number;
}

/**
 * `created_at` clamped to at most now + skew (PROTO-8): a future-dated rumor gains
 * no ordering advantage. Past/within-skew timestamps pass through unchanged. Pure —
 * takes the reference time so callers/tests can pin it.
 */
export function rumorEffectiveCreatedAt(
  createdAt: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  const maxCreatedAt = nowSec + RUMOR_MAX_CLOCK_SKEW_SEC;
  return createdAt > maxCreatedAt ? maxCreatedAt : createdAt;
}

/**
 * Structural + binding + integrity checks applied to a just-decrypted rumor,
 * WITHOUT mutating it (audit R19). Asserts the rumor shape, binds its claimed
 * author to the verified seal author, and recomputes/checks its id. Returns the
 * untouched authenticated rumor plus the clamped `effectiveCreatedAt` for local
 * ordering policy. This is the mutation-free core the coordinator and any
 * ordering-correct consumer should use.
 */
export function finalizeUnwrappedRumorEnvelope(
  raw: unknown,
  sealPubkey: string,
): UnwrappedRumor {
  assertRumorShape(raw);
  const rumor = raw;
  if (rumor.pubkey !== sealPubkey) {
    throw new Error("rumor/seal author mismatch");
  }
  // The rumor id is sender-chosen but consumers dedupe by it — recompute it over
  // the unsigned-event serialization (the same construction nostr-tools'
  // createRumor uses in wrapRumor) and reject a mismatch, so a hand-rolled seal
  // can't smuggle in an arbitrary id.
  const expectedId = getEventHash({
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  });
  if (rumor.id !== expectedId) {
    throw new Error("rumor id does not match its contents");
  }
  // Authenticated fields are preserved; ordering uses the separate clamped value.
  return { rumor, effectiveCreatedAt: rumorEffectiveCreatedAt(rumor.created_at) };
}

/**
 * Backward-compatible finalizer (app path): same checks as
 * {@link finalizeUnwrappedRumorEnvelope}, but returns a Rumor whose `created_at`
 * is the clamped effective value (PROTO-8), so existing first-come/latest-wins
 * consumers keep the timestamp-clamp protection without a call-site change. Unlike
 * the pre-R19 version this does NOT mutate the input — it returns a shallow copy —
 * so the caller's decrypted object is never altered. Ordering-correct consumers
 * that also need the untouched authenticated rumor should call the Envelope form.
 */
export function finalizeUnwrappedRumor(raw: unknown, sealPubkey: string): Rumor {
  const { rumor, effectiveCreatedAt } = finalizeUnwrappedRumorEnvelope(raw, sealPubkey);
  return effectiveCreatedAt === rumor.created_at
    ? rumor
    : { ...rumor, created_at: effectiveCreatedAt };
}

export interface RumorInput {
  kind: RumorKind;
  /** JSON-serializable payload; stringified into rumor content. */
  content: unknown;
  tags?: string[][];
  /** Override rumor timestamp (defaults to now). */
  created_at?: number;
}

/**
 * Build a gift wrap: serialize the payload, create the rumor of the given kind,
 * seal it (signed by `senderSk`), and wrap it to `recipientPubkey`.
 */
export function wrapRumor(
  senderSk: Uint8Array,
  recipientPubkey: string,
  input: RumorInput,
): GiftWrap {
  const rumorEvent: {
    kind: number;
    content: string;
    tags: string[][];
    created_at?: number;
  } = {
    kind: input.kind,
    content:
      typeof input.content === "string"
        ? input.content
        : JSON.stringify(input.content),
    tags: input.tags ?? [],
  };
  if (input.created_at !== undefined) rumorEvent.created_at = input.created_at;
  // nostr-tools sets rumor.pubkey = getPublicKey(senderSk); seal is signed by sender.
  return wrapEvent(rumorEvent as any, senderSk, recipientPubkey) as GiftWrap;
}

/**
 * Unwrap a gift wrap addressed to `recipientSk`, returning the inner rumor.
 * Throws if the wrap is not decryptable by this key or fails verification.
 *
 * Unlike nostr-tools' `unwrapEvent`, this enforces the NIP-59 author binding
 * AGAINST A VERIFIED SEAL. NIP-44 decryption does NOT authenticate the sender:
 * ECDH(recipientSk, seal.pubkey) equals ECDH(sealSk, recipientPk), so anyone
 * holding `recipientSk` can encrypt a seal under any claimed sender pubkey and it
 * will decrypt. Only the seal's kind-13 Schnorr signature proves seal authorship.
 * So we verify the outer 1059 wrap (defense in depth), require a complete signed
 * kind-13 seal with empty tags, then bind `rumor.pubkey === seal.pubkey` — after
 * which `rumor.pubkey` is a trustworthy authenticated identity the 21603/21604
 * `seal-author == E_id` and attendee-action checks depend on (mirrored by the
 * app's `signerUnwrap`).
 */
export function unwrapRumor(wrap: GiftWrap, recipientSk: Uint8Array): Rumor {
  const { rumor, effectiveCreatedAt } = unwrapRumorEnvelope(wrap, recipientSk);
  return effectiveCreatedAt === rumor.created_at
    ? rumor
    : { ...rumor, created_at: effectiveCreatedAt };
}

/**
 * Like {@link unwrapRumor} but returns the untouched authenticated rumor plus the
 * clamped `effectiveCreatedAt` (audit R19). The returned `rumor.created_at` is
 * exactly what the seal author signed, so `rumor.id` still hashes its contents;
 * use `effectiveCreatedAt` for local first-come/latest-wins ordering. The
 * coordinator uses this so its durable command ordering is authenticated and not
 * processing-time-dependent.
 */
export function unwrapRumorEnvelope(
  wrap: GiftWrap,
  recipientSk: Uint8Array,
): UnwrappedRumor {
  if (wrap.kind !== KIND_GIFT_WRAP) {
    throw new Error(`not a gift wrap (kind ${wrap.kind})`);
  }
  if (!verifyEvent(wrap as unknown as NostrEvent)) {
    throw new Error("gift wrap signature is invalid");
  }
  const seal: unknown = JSON.parse(
    nip44Decrypt(recipientSk, wrap.pubkey, wrap.content),
  );
  assertVerifiedSeal(seal);
  const rumor: unknown = JSON.parse(
    nip44Decrypt(recipientSk, seal.pubkey, seal.content),
  );
  return finalizeUnwrappedRumorEnvelope(rumor, seal.pubkey);
}

/** Parse a rumor's JSON content into a typed value (caller validates with zod). */
export function rumorPayload<T = unknown>(rumor: Rumor): T {
  return JSON.parse(rumor.content) as T;
}

/**
 * `since` value for gift-wrap subscriptions: now − 3 days, accounting for the
 * up-to-2-day past randomization of wrap timestamps (IMPLEMENTATION_PLAN §3.4).
 */
export function giftwrapSince(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return nowSec - 3 * 24 * 60 * 60;
}

/** The public key corresponding to a secret key (re-export for convenience). */
export function pubkeyOf(sk: Uint8Array): string {
  return getPublicKey(sk);
}
