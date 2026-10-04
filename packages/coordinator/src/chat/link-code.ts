/**
 * One-time codes for linking an external Marmot client (NIP §10.5).
 *
 * The coordinator posts the code inside a throwaway Marmot group whose only other
 * member is the external key, so reading it proves the reader holds that key. The
 * user then types it into Nostrautica, which seals it back to us under the account
 * key. Only a hash is ever stored: a database leak must not hand out live codes.
 */
import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import {
  CHAT_LINK_CODE_ALPHABET,
  CHAT_LINK_CODE_LENGTH,
  normalizeChatLinkCode,
} from "@nostrautica/protocol";

const CODE_HASH_TAG = "nostrautica-chat-link-code-v1";

/** A fresh code from the unambiguous alphabet, uniform per character (CSPRNG). */
export function generateChatLinkCode(): string {
  let out = "";
  for (let i = 0; i < CHAT_LINK_CODE_LENGTH; i++) {
    out += CHAT_LINK_CODE_ALPHABET[randomInt(CHAT_LINK_CODE_ALPHABET.length)];
  }
  return out;
}

/** "ABCDEFGH" → "ABCD-EFGH": the form shown to the user. */
export function formatChatLinkCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * Hash a code bound to the exact link it was issued for, so a stored hash says
 * nothing useful about any other (coordinate, account, external key) and a code
 * issued for one link can never confirm another.
 */
export function hashChatLinkCode(
  code: string,
  coordinate: string,
  accountPubkey: string,
  chatPubkey: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([CODE_HASH_TAG, coordinate, accountPubkey, chatPubkey, normalizeChatLinkCode(code)]))
    .digest("hex");
}

/** Constant-time compare of a typed code against a stored hash. */
export function chatLinkCodeMatches(
  typed: string,
  storedHash: string,
  coordinate: string,
  accountPubkey: string,
  chatPubkey: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const got = Buffer.from(hashChatLinkCode(typed, coordinate, accountPubkey, chatPubkey), "hex");
  return timingSafeEqual(got, Buffer.from(storedHash, "hex"));
}

/** The one message posted in the confirmation group. English only: the daemon has no locale. */
export function chatLinkCodeMessage(code: string, ttlMinutes: number): string {
  return [
    `Your Nostrautica link code: ${formatChatLinkCode(code)}`,
    "",
    "Type this code into Nostrautica (event chat, \"Also chat from White Noise\") to finish linking this account to your event chat.",
    `It expires in ${ttlMinutes} minutes. Don't share it with anyone. You can leave this group once you're done.`,
  ].join("\n");
}
