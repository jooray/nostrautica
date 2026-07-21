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
import { npubEncode } from "nostr-tools/nip19";
import type { EventTemplate } from "nostr-tools/pure";
import {
  nip44Encrypt,
  nip44Decrypt,
  bytesToHex,
  bytesToBase64,
  base64ToBytes,
  KIND_PROFILE,
} from "@nostrautica/protocol";
import {
  signAccountIdentityProof,
  type AccountIdentityProofSigner,
} from "@internet-privacy/marmot-ts/core";
import type { AppSigner } from "$lib/signer/types.js";
import { marmotKvBackend, identityPrefix } from "./stores.js";

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

/**
 * `unlockChatIdentityForLogin` in flight, per account (audit UX-6 race). Login
 * doesn't wait for it (a NIP-46 decrypt round-trips over relays, and
 * `+layout.svelte`'s UX-19 fix deliberately runs `session.restore()` in the
 * background rather than gating first paint) — so `session.loggedIn` can go
 * true, and a chat prewarm can call `resolveChatIdentity`, WHILE the real
 * device key is still mid-restore. Without this, `ensureChatDeviceKey` would
 * see "no device key yet" and mint a fresh one — forking the account's MLS
 * credential (every other client sees a stranger; old group membership lost).
 */
const unlockInFlight = new Map<string, Promise<void>>();

/** Generate + persist a fresh chat device key for an account (once per install). */
async function ensureChatDeviceKey(account: string): Promise<Uint8Array> {
  // Let a real key restore first, if one's landing. Only WAIT for it to settle
  // — an unlock failure (e.g. a storage error) is that caller's problem, not
  // this unrelated one's; swallow it here rather than letting it propagate
  // into a concurrent resolveChatIdentity that has nothing to do with it.
  await unlockInFlight.get(account)?.catch(() => {});
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

const LOCKED_NS = "__chat_locked__";
function lockedKey(account: string): string {
  return `${LOCKED_NS}\x1f${account}`;
}

/** JSON-safe round-trip for values that may hold a `Uint8Array` anywhere in
 *  their structure (raw device keys, marmot's rewind tree, MLS secrets) —
 *  everything else in marmot's persisted state is already JSON-native. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { __u8__: bytesToBase64(value) } : value;
}
function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__u8__" in (value as Record<string, unknown>)) {
    return base64ToBytes((value as { __u8__: string }).__u8__);
  }
  return value;
}

/**
 * Every raw backend key this account's chat identity touches: the namespaced
 * state under the account pubkey itself (local-key accounts, whose chat
 * identity IS the account key) plus — when a dedicated device key was ever
 * persisted (remote-signer accounts) — that key's own storage slot, its
 * client-id slot, and its namespaced state too. Neither slot exists until
 * chat has actually been used, so an account that never opened chat yields
 * nothing to lock.
 */
async function chatKeysFor(account: string): Promise<string[]> {
  const backend = marmotKvBackend();
  const keys = new Set<string>(await backend.keysWithPrefix(identityPrefix(account)));
  const deviceKey = await loadChatDeviceKey(account);
  if (deviceKey) {
    const chatPubkey = getPublicKey(deviceKey);
    for (const k of await backend.keysWithPrefix(identityPrefix(chatPubkey))) keys.add(k);
    keys.add(deviceKeyKey(account));
    keys.add(clientIdKey(chatPubkey));
  }
  return [...keys];
}

/**
 * Self-encrypt this account's MLS/chat state (device key, group state, key
 * packages, decrypted message history) into one on-device snapshot and drop
 * the plaintext (audit UX-6) — same guarantee as
 * `events/keystore.ts#lockEventKeysForLogout`: nothing is lost (the encrypted
 * snapshot survives logout), nothing sits in the clear for the next person on
 * a shared device to read. `encrypt` is the caller's self-encrypt (NIP-44 to
 * the ACCOUNT's own pubkey, not the chat identity's — so unlock always knows
 * where to look regardless of which chat identity a session resolves to).
 * A no-op if chat was never used on this device for this account.
 */
export async function lockChatIdentityForLogout(
  account: string,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<void> {
  const backend = marmotKvBackend();
  const keys = await chatKeysFor(account);
  if (keys.length === 0) return;
  try {
    const dump: Record<string, unknown> = {};
    for (const key of keys) dump[key] = await backend.get(key);
    const ciphertext = await encrypt(JSON.stringify(dump, replacer));
    await backend.set(lockedKey(account), ciphertext);
    for (const key of keys) await backend.del(key);
  } catch {
    /* left in plaintext (e.g. signer unreachable) — retried next logout */
  }
}

/**
 * Reverse of {@link lockChatIdentityForLogout}: decrypt this account's locked
 * chat snapshot back into live storage (audit UX-6). Call on login/restore
 * BEFORE anything resolves a chat identity — otherwise a remote-signer
 * account with no device key restored yet would mint a brand new one
 * (`resolveChatIdentity` → `ensureChatDeviceKey`), forking its MLS credential:
 * every other client would see it as a stranger, having lost its old group
 * membership. Undecryptable (wrong/no signer yet) leaves the snapshot in
 * place for a later retry rather than losing it.
 */
export async function unlockChatIdentityForLogin(
  account: string,
  decrypt: (ciphertext: string) => Promise<string>,
): Promise<void> {
  // Registered SYNCHRONOUSLY (before any await) so a concurrent
  // `resolveChatIdentity` call — however early it races in — can always see
  // this in-flight restore and wait for it (see `unlockInFlight`'s doc comment).
  const run = (async () => {
    const backend = marmotKvBackend();
    const ciphertext = await backend.get(lockedKey(account));
    if (typeof ciphertext !== "string") return;
    try {
      const dump = JSON.parse(await decrypt(ciphertext), reviver) as Record<string, unknown>;
      for (const [key, value] of Object.entries(dump)) await backend.set(key, value);
      await backend.del(lockedKey(account));
    } catch {
      /* undecryptable (or the signer isn't ready yet) — retried next login */
    }
  })();
  unlockInFlight.set(account, run);
  try {
    await run;
  } finally {
    // Only clear if we're still the current entry — a newer overlapping call
    // for the same account (rapid logout/login) owns the slot otherwise.
    if (unlockInFlight.get(account) === run) unlockInFlight.delete(account);
  }
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
 * Marmot clients — and our own chat UI, which resolves sender names/avatars by
 * fetching the chat-identity pubkey's own kind-0 — render it sensibly (§3.2):
 * the account's display name/picture, a "Nostrautica" + "(chat)" marker so it
 * reads as an app-scoped child key rather than a person (user feedback
 * 2026-07-20), and the real account's npub in `about` so anyone who runs into
 * this key elsewhere can find who it actually belongs to. Local-key identities
 * don't need this (their kind-0 is the user's own).
 */
export function buildChatKeyProfile(
  identity: ChatIdentity,
  accountName: string | undefined,
  accountPicture?: string,
): ReturnType<typeof finalizeEvent> {
  const name = `Nostrautica ${accountName?.trim() || "user"} (chat)`;
  const npub = npubEncode(identity.account);
  const content = JSON.stringify({
    name,
    about: `Nostrautica MLS chat key for a Nostrautica event — not a person. Follow ${npub} for the main account this belongs to. Messages are end-to-end encrypted.`,
    ...(accountPicture ? { picture: accountPicture } : {}),
  });
  return identity.eventSigner.signEvent({
    kind: KIND_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  });
}
