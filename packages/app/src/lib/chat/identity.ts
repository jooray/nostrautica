/**
 * Marmot chat identity resolution (MARMOT-GROUP-CHAT §3, Phase 2).
 *
 * The mandatory `marmot.account-identity-proof.v1` leaf requires **raw BIP-340**
 * signing over a 32-byte digest that is not a Nostr event — something NIP-46/Amber
 * and NIP-07 cannot do. Resolution (§3.2): the MLS account identity for chat is
 * always a key the app holds locally.
 *
 *  - **Local-key accounts** (`AppSigner.getSecretKey` present): the account key IS
 *    the chat identity. Full native interop — the member appears under the user's
 *    own npub in every Marmot client.
 *  - **NIP-46 / NIP-07 accounts**: a dedicated **chat device key** is generated
 *    once per install and persisted (IndexedDB, same secret class as `local-sk`,
 *    SPECIFICATION.md §14). It signs the 30443, the 10050/10002, the identity
 *    proof, and appears as the member. The real account is bound to it out of band
 *    via a kind-21607 attestation (see `attest.ts`).
 *
 * Either way the chat identity holds a raw 32-byte key locally, so the
 * `accountProofSigner` hook is uniform: `signAccountIdentityProof(req, sk)`.
 */
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { nip44Encrypt, nip44Decrypt, bytesToHex, KIND_PROFILE } from "@nostrautica/protocol";
import {
  signAccountIdentityProof,
  type AccountIdentityProofSigner,
} from "@internet-privacy/marmot-ts/core";
import type { AppSigner } from "$lib/signer/types.js";
import { marmotKvBackend } from "./stores.js";

/**
 * The applesauce `EventSigner` shape marmot-ts expects. Declared structurally so
 * the app never has to resolve the (non-hoisted) applesauce-core types; the object
 * is checked structurally where the `MarmotClient` is constructed.
 */
export interface ChatEventSigner {
  getPublicKey(): string;
  signEvent(draft: EventTemplate): ReturnType<typeof finalizeEvent>;
  nip44: {
    encrypt(pubkey: string, plaintext: string): string;
    decrypt(pubkey: string, ciphertext: string): string;
  };
}

/** A resolved chat identity: everything the MarmotClient wrapper needs. */
export interface ChatIdentity {
  /** MLS account identity pubkey (hex) — the member npub other clients see. */
  pubkey: string;
  /** The owning Nostr account pubkey (hex). Equals `pubkey` for local-key accounts. */
  account: string;
  /** True when the account key itself is the chat identity (no attestation needed). */
  isAccountKey: boolean;
  /** applesauce-shaped signer over the chat identity's raw key. */
  eventSigner: ChatEventSigner;
  /** Raw BIP-340 proof signer (§3.1) over the chat identity's key. */
  accountProofSigner: AccountIdentityProofSigner;
  /** Stable per-install 30443 slot id (`clientId`). */
  clientId: string;
  /** The chat identity's raw secret key (held locally; never leaves the device unencrypted). */
  secretKey: Uint8Array;
}

// ── Persistence (IndexedDB via the shared marmot KV backend) ──────────────────
const DEVICE_KEY_NS = "__chat_device_key__";
const CLIENT_ID_NS = "__chat_client_id__";

function deviceKeyKey(account: string): string {
  return `${DEVICE_KEY_NS}\x1f${account}`;
}
function clientIdKey(chatPubkey: string): string {
  return `${CLIENT_ID_NS}\x1f${chatPubkey}`;
}

/** Load the persisted chat device key for an account, or undefined. */
export async function loadChatDeviceKey(account: string): Promise<Uint8Array | undefined> {
  const stored = await marmotKvBackend().get(deviceKeyKey(account));
  return stored instanceof Uint8Array ? new Uint8Array(stored) : undefined;
}

/** Generate + persist a fresh chat device key for an account (once per install). */
async function ensureChatDeviceKey(account: string): Promise<Uint8Array> {
  const existing = await loadChatDeviceKey(account);
  if (existing) return existing;
  const sk = generateSecretKey();
  await marmotKvBackend().set(deviceKeyKey(account), new Uint8Array(sk));
  return sk;
}

/** A stable per-install slot id for this chat identity's 30443 events. */
async function ensureClientId(chatPubkey: string): Promise<string> {
  const backend = marmotKvBackend();
  const existing = await backend.get(clientIdKey(chatPubkey));
  if (typeof existing === "string" && existing) return existing;
  // Short random slot id — one addressable 30443 `d` per install/device.
  const id = "web-" + bytesToHex(generateSecretKey()).slice(0, 16);
  await backend.set(clientIdKey(chatPubkey), id);
  return id;
}

/** Build an applesauce-shaped `EventSigner` over a raw 32-byte key. */
export function eventSignerFromKey(sk: Uint8Array): ChatEventSigner {
  const pk = getPublicKey(sk);
  return {
    getPublicKey: () => pk,
    signEvent: (draft: EventTemplate) =>
      finalizeEvent(
        {
          kind: draft.kind,
          created_at: draft.created_at ?? Math.floor(Date.now() / 1000),
          tags: draft.tags ?? [],
          content: draft.content ?? "",
        },
        sk,
      ),
    nip44: {
      encrypt: (pubkey: string, plaintext: string) => nip44Encrypt(sk, pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => nip44Decrypt(sk, pubkey, ciphertext),
    },
  };
}

/**
 * Resolve the chat identity for the logged-in account. Local-key accounts reuse
 * the account key; remote-signer accounts get (and persist) a dedicated device key.
 */
export async function resolveChatIdentity(accountSigner: AppSigner): Promise<ChatIdentity> {
  const account = await accountSigner.getPublicKey();
  const rawAccountKey = accountSigner.getSecretKey?.();

  const sk = rawAccountKey ? new Uint8Array(rawAccountKey) : await ensureChatDeviceKey(account);
  const pubkey = getPublicKey(sk);
  const isAccountKey = pubkey === account;
  const clientId = await ensureClientId(pubkey);

  return {
    pubkey,
    account,
    isAccountKey,
    eventSigner: eventSignerFromKey(sk),
    accountProofSigner: (request) => signAccountIdentityProof(request, sk),
    clientId,
    secretKey: sk,
  };
}

/**
 * Build the locally-signed kind-0 profile a chat device key publishes so other
 * Marmot clients render it sensibly (§3.2): the account's display name + a
 * "(chat)" marker. Local-key identities don't need this (their kind-0 is the
 * user's own).
 */
export function buildChatKeyProfile(
  identity: ChatIdentity,
  accountName: string | undefined,
): ReturnType<typeof finalizeEvent> {
  const name = (accountName?.trim() || "Nostrautica user") + " (chat)";
  const content = JSON.stringify({
    name,
    about: "Marmot chat identity for a Nostrautica event. Messages are end-to-end encrypted.",
  });
  return identity.eventSigner.signEvent({
    kind: KIND_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  });
}
