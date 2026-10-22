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
 *
 * A display name is also self-asserted, so it can never be what decides who
 * receives a private message (audit R-30). Anyone can call themselves "Juraj":
 * when two accounts share the typed name the command stays in the picker, and
 * the person picked there is PINNED by pubkey for as long as the line still
 * starts with the completion. Typing over the name drops the pin and goes back
 * to matching.
 */

export interface DmTarget {
  /** The person's ACCOUNT pubkey — never a chat device key, which is app-scoped. */
  account: string;
  name: string;
}

export type DmCommand =
  /** A recipient is settled; `body` may be empty, meaning "just open it". */
  | { ready: true; target: DmTarget; body: string }
  /** Still choosing: `query` is what to filter the picker by. `body` is a
   *  message already typed after a name two people share, kept through the pick. */
  | { ready: false; query: string; body?: string };

/**
 * A recipient chosen in the picker, held by pubkey. `prefix` is the exact
 * composer text the completion wrote (`/msg <name> `); the pin holds only while
 * the draft still starts with it.
 */
export interface DmPin {
  target: DmTarget;
  prefix: string;
}

/** `/m`, `/msg`, each either followed by whitespace or the whole line so far. */
const CMD_RE = /^\/(?:m|msg)(?:\s+|$)/i;

function startsWithFold(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** The composer text that completes `/msg` to `target`, and the pin for it. */
export function pinDmTarget(target: DmTarget): DmPin {
  return { target, prefix: `/msg ${target.name} ` };
}

/** Is `pin` still in force for this draft (and is its person still here)? */
export function pinHolds(draft: string, pin: DmPin | null, targets: readonly DmTarget[]): pin is DmPin {
  return !!pin && draft.startsWith(pin.prefix) && targets.some((t) => t.account === pin.target.account);
}

/**
 * What the composer text currently means, or `null` when it is an ordinary
 * message. Returning null for anything that is not a command is what keeps a
 * message like "/msgpack is fine" out of this path entirely.
 */
export function parseDmCommand(
  draft: string,
  targets: readonly DmTarget[],
  pin: DmPin | null = null,
): DmCommand | null {
  const m = CMD_RE.exec(draft);
  if (!m) return null;
  // The picked person, not whoever the name resolves to now.
  if (pinHolds(draft, pin, targets)) {
    return { ready: true, target: pin.target, body: draft.slice(pin.prefix.length).trim() };
  }
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
    // Two accounts answering to the same name is never settled by typing: the
    // person has to be picked, where the short npub tells them apart.
    const name = best.name.toLowerCase();
    const tied = targets.some((c) => c.account !== best!.account && c.name.toLowerCase() === name);
    if (tied) {
      const body = rest.slice(best.name.length).trim();
      return { ready: false, query: best.name, ...(body ? { body } : {}) };
    }
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
