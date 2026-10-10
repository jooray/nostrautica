import { type UnsignedEvent } from "applesauce-core/helpers/event";
import type { EventSigner } from "applesauce-core/factories";
/** Encoded byte length of a {@link AuthorizationProof} envelope. */
export declare const AUTHORIZATION_PROOF_LENGTH = 104;
/**
 * Largest `created_at` the envelope accepts (`2^53 - 1`), per the spec's requirement that
 * the value be represented exactly by interoperable JSON implementations.
 */
export declare const AUTHORIZATION_PROOF_MAX_CREATED_AT = 9007199254740991;
/**
 * The reason a `MarmotAuthorizationProof` (or its produce/verify path) was rejected. One
 * literal per spec validation step — never a coarse bucket. The `returned-*` reasons cover
 * `produceAuthorizationProof`'s per-field external-signer substitution checks (Task 2).
 */
export type AuthorizationProofRejectReason = "invalid-length" | "invalid-signer-pubkey" | "created-at-out-of-range" | "created-at-non-integer" | "malformed-template" | "invalid-signature" | "returned-event-malformed" | "returned-pubkey-mismatch" | "returned-created-at-mismatch" | "returned-kind-mismatch" | "returned-tags-mismatch" | "returned-content-mismatch" | "returned-id-mismatch" | "returned-signature-invalid";
/** Thrown for every rejection in this module. */
export declare class AuthorizationProofError extends Error {
    readonly reason: AuthorizationProofRejectReason;
    constructor(message: string, reason: AuthorizationProofRejectReason);
}
/** A decoded or produced `MarmotAuthorizationProof` envelope. */
export interface AuthorizationProof {
    /** 32-byte x-only secp256k1 signer public key. */
    signerPubkey: Uint8Array;
    /** Unix timestamp in seconds; range `[1, 2^53 - 1]`. */
    createdAt: number;
    /** 64-byte BIP-340 Schnorr signature. */
    signature: Uint8Array;
}
/**
 * Encodes a {@link AuthorizationProof} to its exact 104-byte wire form
 * (`signer_pubkey[32] | created_at uint64 BE | signature[64]`). Validates every field
 * before writing.
 */
export declare function encodeAuthorizationProof(proof: AuthorizationProof): Uint8Array;
/**
 * Decodes exactly one 104-byte `MarmotAuthorizationProof`, rejecting truncation or
 * trailing bytes. Follows the spec verifier's step order: length, then signer_pubkey
 * validity, then the `created_at` range (checked as a `bigint` before converting to
 * `Number`, so an out-of-range wire value can never silently become a smaller in-range
 * number). Never checks the signature — that is `verifyAuthorizationProof`'s job (Task 2).
 */
export declare function decodeAuthorizationProof(data: Uint8Array): AuthorizationProof;
/**
 * The plain data template a proof class supplies for its own event: the exact `kind`,
 * ordered `tags`, and `content` the owning proof-class document defines. There is no
 * `ProofClass` descriptor interface and no kind registry — exact tag order/values are the
 * proof class's responsibility, covered by the event-id recompute in
 * {@link verifyAuthorizationProof} and {@link produceAuthorizationProof}.
 */
export interface AuthorizationProofTemplate {
    kind: number;
    tags: string[][];
    content: string;
}
/**
 * The minimal signer contract `produceAuthorizationProof` needs: a subset of
 * applesauce-core's `EventSigner`. A hand-rolled `{ signEvent }` object and a full
 * `EventSigner` both satisfy this type; the signer's public-key accessor is never
 * pre-flighted (the caller supplies the expected signer pubkey explicitly).
 */
export type AuthorizationProofSigner = Pick<EventSigner, "signEvent">;
/** Parameters for {@link produceAuthorizationProof}. */
export interface ProduceAuthorizationProofParams {
    template: AuthorizationProofTemplate;
    /** The signer's expected 32-byte x-only Nostr pubkey. */
    signerPubkey: Uint8Array;
    signer: AuthorizationProofSigner;
    /** Injected Unix timestamp in seconds; defaults to the current time. */
    createdAt?: number;
}
/**
 * Builds the exact unsigned proof event for a template, signer pubkey, and `created_at`:
 * validates the signer pubkey, `created_at`, and template (in that order, so the reason is
 * deterministic when several inputs are bad) and returns a fresh event with cloned tags.
 */
export declare function buildAuthorizationProofEvent(template: AuthorizationProofTemplate, signerPubkey: Uint8Array, createdAt: number): UnsignedEvent;
/** Returns the lowercase-hex NIP-01 event id of the reconstructed proof event. */
export declare function authorizationProofEventId(template: AuthorizationProofTemplate, signerPubkey: Uint8Array, createdAt: number): string;
/**
 * Validates a `MarmotAuthorizationProof` against a proof-class template — spec verifier
 * steps 1-6: decode/structural checks (1-3), NIP-01 event reconstruction (4), event-id
 * computation (5), and BIP-340 verification (6). Accepts either raw 104-byte envelope
 * bytes or an already-decoded proof object (a hand-built object still runs steps 2-3).
 *
 * Class-specific signer-authorization, binding, carrier, and freshness rules belong to the
 * owning proof class, not this primitive. There is deliberately no wall-clock comparison —
 * the spec forbids receiver-side `created_at` expiry.
 */
export declare function verifyAuthorizationProof(template: AuthorizationProofTemplate, proof: AuthorizationProof | Uint8Array): AuthorizationProof;
/**
 * Produces a `MarmotAuthorizationProof` by asking an external Nostr event signer to sign
 * the exact proof event, then strictly validating the returned event before extracting the
 * envelope (spec "Producing a proof" steps 2-5). `createdAt` defaults to the producer's
 * current Unix time in whole seconds when omitted; an injected `createdAt` is used verbatim.
 *
 * The signer pubkey, `created_at`, and template are validated before the signer is ever
 * invoked (so an invalid request never reaches the signer). The returned event's `pubkey`,
 * `created_at`, `kind`, `tags`, and `content` must exactly equal the request, its `id` must
 * equal the recomputed NIP-01 id, and its signature must verify — each substituted field
 * yields its own `returned-*` reason, checked in that order. No hex string is
 * case-normalized: canonical-encoding.md ("Text") requires byte/text equality, not
 * case-insensitive comparison.
 *
 * A throw or rejection from `signer.signEvent` propagates unchanged — that is a signing
 * failure, not a proof rejection.
 */
export declare function produceAuthorizationProof(params: ProduceAuthorizationProofParams): Promise<AuthorizationProof>;
