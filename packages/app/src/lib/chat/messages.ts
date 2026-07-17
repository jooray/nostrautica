/**
 * Chat message mapping (MARMOT-GROUP-CHAT §7, Phase 2).
 *
 * Inner app payloads are unsigned Nostr-shaped *rumors* inside MLS (§1.2): kind 9
 * chat text, kind 7 reactions, kind 1009 edits. `pubkey` = the sender's chat
 * identity; MLS authenticates authorship, so there is no `sig`. This module maps
 * between those rumors and the UI's `ChatMessage`, and builds the send intent —
 * all pure/serialization logic, unit-tested without a live group.
 */
import {
  createChatRumor,
  createApplicationMessageIntent,
} from "@internet-privacy/marmot-ts/client";
import {
  serializeApplicationRumor,
  deserializeApplicationData,
} from "@internet-privacy/marmot-ts/core";

/** Marmot application-message kinds (§7). */
export const CHAT_KIND_TEXT = 9;
export const CHAT_KIND_REACTION = 7;
export const CHAT_KIND_EDIT = 1009;

/** A decrypted chat message ready for the UI. */
export interface ChatMessage {
  /** The inner rumor id (canonical NIP-01 id — stable, de-dupe key). */
  id: string;
  /** Sender's chat-identity pubkey (hex). */
  pubkey: string;
  /** Application kind (9 text / 7 reaction / 1009 edit). */
  kind: number;
  content: string;
  createdAt: number;
  /** Tags carried on the rumor (e.g. an `e` ref for a reaction/edit target). */
  tags: string[][];
}

/** A minimal shape of the marmot/applesauce Rumor we consume (avoids naming the
 *  non-hoisted applesauce type). */
interface RumorLike {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}

/** Map a decoded application rumor to a `ChatMessage`. */
export function rumorToChatMessage(rumor: RumorLike): ChatMessage {
  return {
    id: rumor.id,
    pubkey: rumor.pubkey,
    kind: rumor.kind,
    content: rumor.content,
    createdAt: rumor.created_at,
    tags: rumor.tags ?? [],
  };
}

/**
 * Build a kind-9 chat rumor authored by `pubkey` and the send intent for it.
 * Drive the intent through `client.groups.send(groupId, intent)`.
 */
export function buildChatSend(
  pubkey: string,
  content: string,
  tags?: string[][],
): { rumor: ReturnType<typeof createChatRumor>; intent: ReturnType<typeof createApplicationMessageIntent> } {
  const rumor = createChatRumor({ pubkey, content, ...(tags ? { tags } : {}) });
  return { rumor, intent: createApplicationMessageIntent(rumor) };
}

/**
 * Decode raw application-message bytes (from the group `applicationMessage` event
 * or a decrypted 445) into a `ChatMessage`. Strict per the Marmot inner-event
 * encoding rules (throws on a non-conformant / id-inconsistent payload).
 */
export function decodeApplicationMessage(data: Uint8Array): ChatMessage {
  return rumorToChatMessage(deserializeApplicationData(data) as unknown as RumorLike);
}

/**
 * Serialize a chat rumor to its Marmot wire bytes then decode it back — the exact
 * round-trip a message makes through MLS. Exposed for tests and as the local
 * echo path (optimistic send renders the same bytes the group will emit).
 */
export function roundTripChatRumor(rumor: RumorLike): ChatMessage {
  const bytes = serializeApplicationRumor(rumor as unknown as Parameters<typeof serializeApplicationRumor>[0]);
  return decodeApplicationMessage(bytes);
}
