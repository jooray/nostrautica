/**
 * Chat message mapping (MARMOT-GROUP-CHAT §7, Phase 2).
 *
 * Inner app payloads are unsigned Nostr-shaped *rumors* inside MLS (§1.2): kind 9
 * chat text, kind 7 reactions, kind 1009 edits, kind 5 deletions. `pubkey` = the sender's chat
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
import { getEventHash } from "nostr-tools/pure";
import { mentionPTags } from "./mentions.js";

/** Marmot application-message kinds (§7), the same numbers MDK uses
 *  (cgka_traits::app_event MARMOT_APP_EVENT_KIND_*). */
export const CHAT_KIND_TEXT = 9;
export const CHAT_KIND_REACTION = 7;
export const CHAT_KIND_EDIT = 1009;
/** Retracts the author's own message, edit or reaction (one `e` tag per target). */
export const CHAT_KIND_DELETE = 5;
/** Every kind the room ingests: text plus the modifiers folded onto it (timeline.ts). */
export const CHAT_KINDS = [CHAT_KIND_TEXT, CHAT_KIND_REACTION, CHAT_KIND_EDIT, CHAT_KIND_DELETE];
/** MDK refuses to send a longer reaction (MAX_REACTION_CONTENT_CHARS) and so do we. */
export const MAX_REACTION_CHARS = 64;

/** A decrypted chat message ready for the UI. */
export interface ChatMessage {
  /** The inner rumor id (canonical NIP-01 id — stable, de-dupe key). */
  id: string;
  /** Sender's chat-identity pubkey (hex). */
  pubkey: string;
  /** Application kind (9 text / 7 reaction / 1009 edit / 5 delete). */
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
 *
 * People mentioned in `content` get a `["p", hex]` tag each, appended after any
 * caller tags, exactly as MDK's inner-event builder does for White Noise
 * (mentions.ts). Derived here rather than by the composer so a follower tab's
 * proxied send, which carries only text, tags them too.
 */
export function buildChatSend(
  pubkey: string,
  content: string,
  tags?: string[][],
): { rumor: ReturnType<typeof createChatRumor>; intent: ReturnType<typeof createApplicationMessageIntent> } {
  const all = [...(tags ?? [])];
  for (const p of mentionPTags(content)) {
    if (!all.some((t) => t[0] === "p" && t[1] === p[1])) all.push(p);
  }
  const rumor = createChatRumor({ pubkey, content, ...(all.length ? { tags: all } : {}) });
  return { rumor, intent: createApplicationMessageIntent(rumor) };
}

type Rumor = ReturnType<typeof createChatRumor>;
type Intent = ReturnType<typeof createApplicationMessageIntent>;

/** An unsigned rumor of any kind, id filled in — createChatRumor, minus the kind 9. */
function makeRumor(pubkey: string, kind: number, content: string, tags: string[][]): Rumor {
  const rumor = createChatRumor({ pubkey, content, tags });
  rumor.kind = kind;
  rumor.id = getEventHash(rumor);
  return rumor;
}

/**
 * The modifiers a chat message can receive, built exactly as MDK's
 * `build_inner_event` builds them (marmot-app messages/intents.rs), so Android
 * and White Noise fold ours and we fold theirs:
 *
 * - reaction: kind 7, content = the emoji, tags `[["e", target]]`;
 * - edit: kind 1009, content = the full new text, tags `[["e", target], ...p]`
 *   where the `p` tags are the mentions in the new text, as on a kind 9;
 * - delete (of a message, or un-react of our own reaction events): kind 5,
 *   empty content, one `["e", id]` per retracted event.
 */
export function buildReactionSend(pubkey: string, target: string, emoji: string): { rumor: Rumor; intent: Intent } {
  if (!target) throw new Error("reaction needs a target message");
  if (!emoji.trim() || [...emoji].length > MAX_REACTION_CHARS) throw new Error("invalid reaction");
  const rumor = makeRumor(pubkey, CHAT_KIND_REACTION, emoji, [["e", target]]);
  return { rumor, intent: createApplicationMessageIntent(rumor) };
}

export function buildEditSend(pubkey: string, target: string, content: string): { rumor: Rumor; intent: Intent } {
  if (!target) throw new Error("edit needs a target message");
  if (!content.trim()) throw new Error("edit requires non-empty content");
  const rumor = makeRumor(pubkey, CHAT_KIND_EDIT, content, [["e", target], ...mentionPTags(content)]);
  return { rumor, intent: createApplicationMessageIntent(rumor) };
}

export function buildDeleteSend(pubkey: string, targets: string[]): { rumor: Rumor; intent: Intent } {
  const ids = [...new Set(targets.filter(Boolean))];
  if (ids.length === 0) throw new Error("nothing to delete");
  const rumor = makeRumor(pubkey, CHAT_KIND_DELETE, "", ids.map((id) => ["e", id]));
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
