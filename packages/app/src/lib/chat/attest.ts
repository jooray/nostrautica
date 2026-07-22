/**
 * Chat device attestation (kind 21607, NIP §10.2, wire v2).
 *
 * Every device (all account types, decision D3) mints its own per-device chat key
 * (`identity.ts`) and binds it to the account with a 21607 rumor gift-wrapped to
 * the event coordinator, **sealed by the account key** (one kind-13 seal — already
 * granted to Amber sessions, so no new NIP-46 permission). The coordinator
 * authenticates the seal author exactly as it authenticates a 21600 join and
 * records `account_pubkey → chat_pubkey`.
 *
 * `op:"add"` additionally carries a **proof of possession**: a BIP-340 signature by
 * the chat DEVICE key over the §10.2 challenge (which binds coordinate, account,
 * chat pubkey, and the rumor's `created_at`). The coordinator verifies it before
 * binding, so an account can no longer attest a key it doesn't control. `op:"revoke"`
 * (lost/retired device) needs no proof.
 */
import {
  KIND_CHAT_KEY_ATTESTATION,
  chatKeyAttestationContentSchema,
  makeChatDeviceProof,
  type ChatKeyAttestationContent,
} from "@nostrautica/protocol";
import type { Rumor } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

/** The attestation body a caller supplies — `v`/`a`/`proof` are filled in here. */
export interface AttestationInput {
  op: "add" | "revoke";
  chatPubkey: string;
  clientId?: string;
  /** Human device label ("Chrome on laptop"). Required for op:"add". */
  label?: string;
  /** Precomputed proof (128-hex). Normally left unset — `sendChatKeyAttestation`
   *  builds it from `deviceSecretKey` over the rumor's created_at. */
  proof?: string;
}

/** Build and validate a 21607 v2 content object (pure — unit-tested). */
export function buildChatKeyAttestationContent(
  coordinate: string,
  input: AttestationInput,
): ChatKeyAttestationContent {
  return chatKeyAttestationContentSchema.parse({
    v: 2,
    a: coordinate,
    op: input.op,
    chat_pubkey: input.chatPubkey,
    ...(input.label ? { label: input.label } : {}),
    ...(input.clientId ? { client_id: input.clientId } : {}),
    ...(input.proof ? { proof: input.proof } : {}),
  });
}

/** Send-side input: the caller passes the device secret so we can build the proof. */
export interface SendAttestationInput {
  op: "add" | "revoke";
  chatPubkey: string;
  clientId?: string;
  label?: string;
  /** The chat device's raw secret key (held locally). Required for op:"add" —
   *  it signs the §10.2 proof of possession. */
  deviceSecretKey?: Uint8Array;
}

/**
 * Gift-wrap a 21607 attestation to the event coordinator, sealed by the account
 * key (`accountSigner`). For `op:"add"` this signs a proof of possession with the
 * device secret over the rumor's `created_at`, so the two timestamps match. No-op-
 * safe to call repeatedly; the coordinator dedupes. Throws if the event has no
 * coordinator (the attestation has no recipient then), or if an add is missing the
 * device secret needed for the proof.
 */
export async function sendChatKeyAttestation(
  accountSigner: AppSigner,
  ctx: EventContext,
  input: SendAttestationInput,
): Promise<void> {
  const coordinator = ctx.config.coordinator;
  if (!coordinator) throw new Error("chat attestation requires a coordinator");
  const account = await accountSigner.getPublicKey();
  const createdAt = Math.floor(Date.now() / 1000);

  let proof: string | undefined;
  if (input.op === "add") {
    if (!input.deviceSecretKey) {
      throw new Error("chat attestation add requires the device secret key for proof of possession");
    }
    proof = makeChatDeviceProof(input.deviceSecretKey, ctx.coordinate, account, createdAt);
  }

  const content = buildChatKeyAttestationContent(ctx.coordinate, {
    op: input.op,
    chatPubkey: input.chatPubkey,
    clientId: input.clientId,
    label: input.label,
    proof,
  });
  const wrap = await signerWrap(accountSigner, coordinator, {
    kind: KIND_CHAT_KEY_ATTESTATION,
    content,
    tags: [["a", ctx.coordinate]],
    created_at: createdAt, // the rumor's created_at must equal what the proof signs
  });
  await publishOrQueue(wrap as unknown as Parameters<typeof publishOrQueue>[0], ctx.config.relays);
}

/**
 * Validate a decoded 21607 rumor's content (used in tests and on any receiving
 * side). The rumor's `pubkey` is the sealed author (the account key, bound by
 * NIP-59 unwrap); an optional `expectedAccount` asserts that binding. Returns the
 * validated content or throws. Does NOT verify the proof of possession — that
 * requires the rumor's created_at and is the coordinator's job.
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
