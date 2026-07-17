/**
 * Chat-key attestation (kind 21607, MARMOT-GROUP-CHAT §3.3, Phase 2).
 *
 * NIP-46/NIP-07 accounts chat under a dedicated device key (`identity.ts`) that no
 * other client can tie to the real account. This binds the two: a kind-21607 rumor
 * gift-wrapped to the event coordinator, **sealed by the account key** (one kind-13
 * seal — already granted to Amber sessions, so no new NIP-46 permission). The
 * coordinator authenticates the seal author exactly as it authenticates a 21600
 * join and records `account_pubkey → chat_pubkey`. `op:"revoke"` (lost device)
 * tells it to remove that chat key's leaves and stop re-adding it.
 *
 * Local-key accounts never call this — their account key *is* the chat identity.
 */
import {
  KIND_CHAT_KEY_ATTESTATION,
  chatKeyAttestationContentSchema,
  type ChatKeyAttestationContent,
} from "@nostrautica/protocol";
import type { Rumor } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

/** The attestation body a caller supplies — `v`/`a` are filled from the ctx. */
export interface AttestationInput {
  op: "add" | "revoke";
  chatPubkey: string;
  clientId?: string;
}

/** Build and validate a 21607 content object (pure — unit-tested). */
export function buildChatKeyAttestationContent(
  coordinate: string,
  input: AttestationInput,
): ChatKeyAttestationContent {
  return chatKeyAttestationContentSchema.parse({
    v: 1,
    a: coordinate,
    op: input.op,
    chat_pubkey: input.chatPubkey,
    ...(input.clientId ? { client_id: input.clientId } : {}),
  });
}

/**
 * Gift-wrap a 21607 attestation to the event coordinator, sealed by the account
 * key (`accountSigner`). No-op-safe to call repeatedly; the coordinator dedupes.
 * Throws if the event has no coordinator (attestation has no recipient then).
 */
export async function sendChatKeyAttestation(
  accountSigner: AppSigner,
  ctx: EventContext,
  input: AttestationInput,
): Promise<void> {
  const coordinator = ctx.config.coordinator;
  if (!coordinator) throw new Error("chat attestation requires a coordinator");
  const content = buildChatKeyAttestationContent(ctx.coordinate, input);
  const wrap = await signerWrap(accountSigner, coordinator, {
    kind: KIND_CHAT_KEY_ATTESTATION,
    content,
    tags: [["a", ctx.coordinate]],
  });
  await publishOrQueue(wrap as unknown as Parameters<typeof publishOrQueue>[0], ctx.config.relays);
}

/**
 * Validate a decoded 21607 rumor's content (used on the receiving/coordinator side
 * and in tests). The rumor's `pubkey` is the sealed author (the account key, bound
 * by NIP-59 unwrap); an optional `expectedAccount` asserts that binding.
 * Returns the validated content or throws.
 */
export function verifyChatKeyAttestation(
  rumor: Pick<Rumor, "kind" | "pubkey" | "content">,
  expectedAccount?: string,
): ChatKeyAttestationContent {
  if (rumor.kind !== KIND_CHAT_KEY_ATTESTATION) {
    throw new Error(`not a chat-key attestation (kind ${rumor.kind})`);
  }
  if (expectedAccount && rumor.pubkey !== expectedAccount) {
    throw new Error("attestation seal author is not the expected account");
  }
  const raw = typeof rumor.content === "string" ? JSON.parse(rumor.content) : rumor.content;
  return chatKeyAttestationContentSchema.parse(raw);
}
