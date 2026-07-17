/**
 * Blossom authorization events (kind 24242, spec §10.3 / BUD-01/02/04). Every
 * upload/mirror/preflight carries a signed kind-24242 event in the
 * `Authorization: Nostr <base64(event)>` header with `t` (verb), `x` (sha256),
 * and `expiration` tags.
 */
import { KIND_BLOSSOM_AUTH } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { bytesToBase64 } from "@nostrautica/protocol";

export type BlossomVerb = "upload" | "get" | "list" | "delete";

export interface BlossomAuthInput {
  verb: BlossomVerb;
  sha256?: string; // ciphertext hash (x) for upload/mirror
  expirationSec?: number; // absolute unix; default now + 1h
  description?: string;
}

/** Build and sign a kind-24242 Blossom auth event. */
export async function buildAuthEvent(signer: AppSigner, input: BlossomAuthInput) {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [["t", input.verb]];
  if (input.sha256) tags.push(["x", input.sha256]);
  tags.push(["expiration", String(input.expirationSec ?? now + 3600)]);
  return signer.signEvent({
    kind: KIND_BLOSSOM_AUTH,
    created_at: now,
    tags,
    content: input.description ?? "",
  });
}

/** Encode a signed auth event as the `Authorization` header value. */
export function authHeader(event: object): string {
  const json = JSON.stringify(event);
  const bytes = new TextEncoder().encode(json);
  return `Nostr ${bytesToBase64(bytes)}`;
}
