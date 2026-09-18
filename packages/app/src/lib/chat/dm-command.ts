/**
 * IRC-style `/m` and `/msg` in the group-chat composer.
 *
 * `/msg <nick> <text>` sends a NIP-17 DM and leaves for that conversation;
 * `/msg <nick>` with no text just opens it — the same split IRC has between
 * /msg and /query.
 *
 * The parsing is here rather than inline in EventChat.svelte because the one
 * hard case has no obvious right answer until you write the examples down: a
 * display name is not an IRC nick and routinely contains spaces ("Juraj
 * Bednár"), so the recipient cannot be "the token after the command". The
 * remainder is matched against the known names instead, LONGEST first, so a
 * member called "Juraj" cannot swallow a message addressed to "Juraj Bednár".
 */

export interface DmTarget {
  /** The person's ACCOUNT pubkey — never a chat device key, which is app-scoped. */
  account: string;
  name: string;
}

export type DmCommand =
  /** A recipient is settled; `body` may be empty, meaning "just open it". */
  | { ready: true; target: DmTarget; body: string }
  /** Still choosing: `query` is what to filter the picker by. */
  | { ready: false; query: string };

/** `/m`, `/msg`, each either followed by whitespace or the whole line so far. */
const CMD_RE = /^\/(?:m|msg)(?:\s+|$)/i;

function startsWithFold(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * What the composer text currently means, or `null` when it is an ordinary
 * message. Returning null for anything that is not a command is what keeps a
 * message like "/msgpack is fine" out of this path entirely.
 */
export function parseDmCommand(draft: string, targets: readonly DmTarget[]): DmCommand | null {
  const m = CMD_RE.exec(draft);
  if (!m) return null;
  const rest = draft.slice(m[0].length);

  let best: DmTarget | null = null;
  for (const c of targets) {
    if (rest.length < c.name.length) continue;
    if (!startsWithFold(rest, c.name)) continue;
    // A settled nick is followed by whitespace, or is the whole remainder.
    const after = rest.slice(c.name.length);
    if (after !== "" && !/^\s/.test(after)) continue;
    if (!best || c.name.length > best.name.length) best = c;
  }

  if (best) {
    // Typed exactly a name with nothing after it: that is only settled if no
    // LONGER name also starts with it. "Juraj" while "Juraj Bednár" is in the
    // room keeps the picker open, because the next keystroke may be a space.
    const settled =
      rest.length > best.name.length ||
      !targets.some((c) => c.name.length > best!.name.length && startsWithFold(c.name, rest));
    if (settled) return { ready: true, target: best, body: rest.slice(best.name.length).trim() };
  }
  return { ready: false, query: rest.trimStart() };
}

/**
 * Who to offer for `query`: prefix matches first, then names containing it.
 * An empty query lists everyone, so `/msg ` alone is a people picker.
 */
export function matchDmTargets(
  targets: readonly DmTarget[],
  query: string,
  limit = 8,
): DmTarget[] {
  const q = query.toLowerCase();
  if (!q) return targets.slice(0, limit);
  const pre: DmTarget[] = [];
  const rest: DmTarget[] = [];
  for (const c of targets) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) pre.push(c);
    else if (n.includes(q)) rest.push(c);
  }
  return [...pre, ...rest].slice(0, limit);
}
