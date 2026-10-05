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

/**
 * The messages posted in the confirmation group, in order. English only: the
 * daemon has no locale.
 *
 * The code goes in a message of its own, last, with nothing else in it: Marmot
 * clients copy a whole message, so a code inside a sentence had to be pasted
 * somewhere and trimmed by hand. Undashed, so the copy is exactly what to type
 * (the app also accepts it with a dash or spaces).
 */
export function chatLinkCodeMessages(code: string, ttlMinutes: number): [string, string] {
  return [
    [
      "Your Nostrautica link code is in the next message.",
      "",
      "Copy it into Nostrautica (event chat, \"Also chat from White Noise or another Marmot client\") to finish linking this account to your event chat.",
      `It expires in ${ttlMinutes} minutes. Don't share it with anyone. You can leave this group once you're done.`,
    ].join("\n"),
    normalizeChatLinkCode(code),
  ];
}
