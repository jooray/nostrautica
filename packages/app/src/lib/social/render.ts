/**
 * Lightweight note rendering (spec §8): NIP-21 mentions, imeta/inline images, and
 * link previews — no full thread rendering in v1. Pure tokenizer so it's testable;
 * the component maps tokens to elements.
 */
export type Token =
  | { type: "text"; value: string }
  | { type: "image"; url: string }
  | { type: "link"; url: string }
  | { type: "mention"; bech32: string };

const URL_RE = /(https?:\/\/[^\s]+)/gi;
const NOSTR_RE = /nostr:((?:npub|nprofile|note|nevent|naddr)1[0-9a-z]+)/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp)(\?[^\s]*)?$/i;

/**
 * Tokenize note content. `imetaUrls` (from imeta tags) are treated as images even
 * if the URL lacks an image extension.
 */
export function parsePostContent(content: string, imetaUrls: string[] = []): Token[] {
  const imeta = new Set(imetaUrls);
  const tokens: Token[] = [];

  // First split out nostr: mentions, then URLs within the remaining text.
  let lastIndex = 0;
  const combined = new RegExp(`${NOSTR_RE.source}|${URL_RE.source}`, "gi");
  for (let m = combined.exec(content); m; m = combined.exec(content)) {
    if (m.index > lastIndex) {
      tokens.push({ type: "text", value: content.slice(lastIndex, m.index) });
    }
    const match = m[0];
    if (match.startsWith("nostr:")) {
      tokens.push({ type: "mention", bech32: match.slice("nostr:".length) });
    } else if (imeta.has(match) || IMAGE_EXT_RE.test(match)) {
      tokens.push({ type: "image", url: match });
    } else {
      tokens.push({ type: "link", url: match });
    }
    lastIndex = m.index + match.length;
  }
  if (lastIndex < content.length) {
    tokens.push({ type: "text", value: content.slice(lastIndex) });
  }
  return tokens;
}

/** Extract image URLs advertised in imeta tags (BUD/NIP-92 style `url ...`). */
export function imetaUrls(tags: string[][]): string[] {
  const urls: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    for (const field of tag.slice(1)) {
      if (field.startsWith("url ")) urls.push(field.slice(4).trim());
    }
  }
  return urls;
}
