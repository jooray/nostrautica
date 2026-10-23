/**
 * Fold a room's raw application messages into what the screen shows.
 *
 * The session keeps every decoded rumor — kind 9 text, and the kind 7 / 1009 / 5
 * modifiers that point at one with an `e` tag — because the modifiers can arrive
 * before their target (history replay order, a late 445) and because follower
 * tabs receive the raw list. Rendering them as they came put every reaction and
 * edit in a bubble of its own. This turns the list into one line per kind 9,
 * applying the same acceptance rules MDK applies on Android and White Noise
 * (storage-sqlite timeline.rs `apply_targeted_modifiers_tx`, timeline/edits.rs),
 * so the three clients agree on what a room says:
 *
 * - a reaction (kind 7) counts towards every message its `e` tags name; one
 *   sender counts once per emoji, and a sender's kind 5 naming the reaction
 *   retracts it;
 * - an edit (kind 1009) is accepted only from the message's own author, with
 *   exactly one `e` tag; the latest by (created_at, id) wins, and the author can
 *   retract an edit with a kind 5;
 * - a delete (kind 5) tombstones a message only when it comes from the author,
 *   and drops its edit and reactions with it.
 *
 * "Author" is the sender's chat DEVICE key, as in MDK: an edit or delete from
 * another device of the same person is not accepted by Android either.
 *
 * Pure and order-independent: the same set of messages folds to the same result
 * whatever order it arrived in.
 */
import {
  CHAT_KIND_DELETE,
  CHAT_KIND_EDIT,
  CHAT_KIND_REACTION,
  CHAT_KIND_TEXT,
  MAX_REACTION_CHARS,
  type ChatMessage,
} from "./messages.js";

/** One emoji's tally on a message. */
export interface ChatReaction {
  emoji: string;
  /** Distinct senders who reacted with it. */
  count: number;
  /** This device is among them. */
  mine: boolean;
  /** Our own live reaction events with this emoji: what an un-react retracts. */
  ownIds: string[];
}

/** A kind 9 as displayed: its effective text plus everything folded onto it. */
export interface ChatTimelineItem extends ChatMessage {
  /** The text as first sent (`content` is the effective, possibly edited, text). */
  originalContent: string;
  edited: boolean;
  deleted: boolean;
  /** In order of first appearance. Empty on a deleted message. */
  reactions: ChatReaction[];
}

function eTargets(m: ChatMessage): string[] {
  return (m.tags ?? []).filter((t) => t[0] === "e" && typeof t[1] === "string" && t[1]).map((t) => t[1]!);
}

const byTimeThenId = (a: ChatMessage, b: ChatMessage): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function foldChatTimeline(messages: readonly ChatMessage[], me?: string): ChatTimelineItem[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of messages) byId.set(m.id, m);

  // Which events have been retracted by their own author.
  const retracted = new Set<string>();
  for (const d of messages) {
    if (d.kind !== CHAT_KIND_DELETE) continue;
    for (const id of eTargets(d)) {
      const target = byId.get(id);
      if (target && target.pubkey === d.pubkey) retracted.add(id);
    }
  }

  const edits = new Map<string, ChatMessage[]>();
  const reactions = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    if (retracted.has(m.id)) continue;
    if (m.kind === CHAT_KIND_EDIT) {
      const targets = eTargets(m);
      if (targets.length !== 1) continue;
      const list = edits.get(targets[0]!) ?? [];
      list.push(m);
      edits.set(targets[0]!, list);
    } else if (m.kind === CHAT_KIND_REACTION) {
      if (!m.content || [...m.content].length > MAX_REACTION_CHARS) continue;
      for (const id of new Set(eTargets(m))) {
        const list = reactions.get(id) ?? [];
        list.push(m);
        reactions.set(id, list);
      }
    }
  }

  const out: ChatTimelineItem[] = [];
  for (const m of messages) {
    if (m.kind !== CHAT_KIND_TEXT) continue;
    const deleted = retracted.has(m.id);
    const item: ChatTimelineItem = {
      ...m,
      originalContent: m.content,
      edited: false,
      deleted,
      reactions: [],
    };
    if (deleted) {
      item.content = "";
      out.push(item);
      continue;
    }
    const accepted = (edits.get(m.id) ?? []).filter((e) => e.pubkey === m.pubkey).sort(byTimeThenId);
    const latest = accepted[accepted.length - 1];
    if (latest) {
      item.content = latest.content;
      item.edited = true;
    }
    const tally = new Map<string, { senders: Set<string>; ownIds: string[] }>();
    for (const r of (reactions.get(m.id) ?? []).sort(byTimeThenId)) {
      const entry = tally.get(r.content) ?? { senders: new Set<string>(), ownIds: [] };
      entry.senders.add(r.pubkey);
      if (me && r.pubkey === me) entry.ownIds.push(r.id);
      tally.set(r.content, entry);
    }
    item.reactions = [...tally].map(([emoji, e]) => ({
      emoji,
      count: e.senders.size,
      mine: !!me && e.senders.has(me),
      ownIds: e.ownIds,
    }));
    out.push(item);
  }
  return out;
}
