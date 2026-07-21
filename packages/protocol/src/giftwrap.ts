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
import { getEventHash, getPublicKey } from "nostr-tools/pure";
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
 * Throws if the wrap is not decryptable by this key.
 *
 * Unlike nostr-tools' `unwrapEvent`, this enforces the NIP-59 author binding:
 * `rumor.pubkey` must equal the seal's author. The seal author is authenticated
 * by the NIP-44 decryption itself (the ciphertext only decrypts under
 * ECDH(recipientSk, seal.pubkey), which the sealer can only compute with
 * seal.pubkey's secret key), so after this check `rumor.pubkey` is trustworthy —
 * the 21603/21604 `seal-author == E_id` checks depend on it (mirrors the app's
 * `signerUnwrap`).
 */
export function unwrapRumor(wrap: GiftWrap, recipientSk: Uint8Array): Rumor {
  if (wrap.kind !== KIND_GIFT_WRAP) {
    throw new Error(`not a gift wrap (kind ${wrap.kind})`);
  }
  const seal = JSON.parse(nip44Decrypt(recipientSk, wrap.pubkey, wrap.content));
  if (seal.kind !== KIND_SEAL) throw new Error("inner event is not a seal");
  const rumor: unknown = JSON.parse(nip44Decrypt(recipientSk, seal.pubkey, seal.content));
  assertRumorShape(rumor);
  if (rumor.pubkey !== seal.pubkey) throw new Error("rumor/seal author mismatch");
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
  // created_at is unauthenticated but drives first-come/latest-wins ordering:
  // clamp future-dated rumors to at most now + skew (PROTO-8). Past timestamps
  // pass through unchanged. The verified id is left alone so it stays a stable
  // dedupe key.
  const maxCreatedAt = Math.floor(Date.now() / 1000) + RUMOR_MAX_CLOCK_SKEW_SEC;
  if (rumor.created_at > maxCreatedAt) rumor.created_at = maxCreatedAt;
  return rumor;
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
