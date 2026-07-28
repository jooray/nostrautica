import { scanDmGiftWraps, type DmMessage } from "$lib/events/dm.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

export interface DmPosition {
  at: number;
  id: string;
}

type ReadWatermarks = Record<string, DmPosition>;
interface EncryptedActivity {
  initialized: boolean;
  known: string[];
  pending: string[];
}

const READ_KEY = "dm-read-watermarks";
const ACTIVITY_KEY = "dm-encrypted-activity";
const MAX_WRAP_IDS = 3000;

export function compareDmPosition(a: DmPosition, b: DmPosition): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id === b.id ? 0 : a.id > b.id ? 1 : -1;
}

export function incomingUnreadCount(
  messages: DmMessage[],
  owner: string,
  peer?: string,
  watermark?: DmPosition,
): number {
  return messages.filter(
    (message) =>
      message.from !== owner &&
      (!peer || message.peer === peer) &&
      (!watermark || compareDmPosition({ at: message.at, id: message.id }, watermark) > 0),
  ).length;
}

function newestIncoming(messages: DmMessage[], owner: string, peer: string): DmPosition | undefined {
  let newest: DmPosition | undefined;
  for (const message of messages) {
    if (message.peer !== peer || message.from === owner) continue;
    const position = { at: message.at, id: message.id };
    if (!newest || compareDmPosition(position, newest) > 0) newest = position;
  }
  return newest;
}

export class DmUnreadStore {
  private owner = $state<string | null>(null);
  private messages = $state<DmMessage[]>([]);
  private watermarks = $state<ReadWatermarks>({});
  private activity = $state<EncryptedActivity>({ initialized: false, known: [], pending: [] });
  private polling: Promise<void> | null = null;

  init(owner: string | null): void {
    if (this.owner !== owner) this.messages = [];
    this.owner = owner;
    this.watermarks = owner ? (cacheGet<ReadWatermarks>(READ_KEY, owner)?.data ?? {}) : {};
    this.activity = owner
      ? (cacheGet<EncryptedActivity>(ACTIVITY_KEY, owner)?.data ?? {
          initialized: false,
          known: [],
          pending: [],
        })
      : { initialized: false, known: [], pending: [] };
  }

  syncMessages(owner: string, messages: DmMessage[]): void {
    if (this.owner !== owner) this.init(owner);
    this.messages = messages;
  }

  threadCount(peer: string): number {
    if (!this.owner) return 0;
    return incomingUnreadCount(this.messages, this.owner, peer, this.watermarks[peer]);
  }

  get confirmedCount(): number {
    if (!this.owner) return 0;
    return Object.keys(
      this.messages.reduce<Record<string, true>>((peers, message) => {
        peers[message.peer] = true;
        return peers;
      }, {}),
    ).reduce((total, peer) => total + this.threadCount(peer), 0);
  }

  get hasEncryptedActivity(): boolean {
    return this.activity.pending.length > 0;
  }

  markThreadRead(peer: string, messages: DmMessage[] = this.messages): void {
    if (!this.owner) return;
    const newest = newestIncoming(messages, this.owner, peer);
    if (!newest || (this.watermarks[peer] && compareDmPosition(newest, this.watermarks[peer]) <= 0)) return;
    this.watermarks = { ...this.watermarks, [peer]: newest };
    cacheSet(READ_KEY, this.watermarks, undefined, this.owner);
  }

  /**
   * Advance every thread's watermark to its newest incoming message at once
   * ("mark all as read"). Threads whose watermark is already at or past their
   * newest incoming message are skipped, so this is idempotent and cannot move a
   * watermark backwards.
   *
   * Deliberately ONE `cacheSet` for the whole batch rather than calling
   * `markThreadRead` per peer — that would persist the map once per thread, so
   * an inbox with fifty conversations would do fifty writes to produce one
   * result. Also acknowledges the ciphertext-only activity badge: that badge
   * exists to say "something arrived that we haven't decrypted yet", and a user
   * asking to mark everything read means that too, not just the threads we
   * happen to have plaintext for.
   */
  markAllRead(messages: DmMessage[] = this.messages): void {
    const owner = this.owner;
    if (!owner) return;
    const next = { ...this.watermarks };
    let changed = false;
    for (const peer of new Set(
      messages.filter((message) => message.from !== owner).map((message) => message.peer),
    )) {
      const newest = newestIncoming(messages, owner, peer);
      if (!newest) continue;
      const prior = next[peer];
      if (prior && compareDmPosition(newest, prior) <= 0) continue;
      next[peer] = newest;
      changed = true;
    }
    if (changed) {
      this.watermarks = next;
      cacheSet(READ_KEY, next, undefined, owner);
    }
    this.acknowledgeEncryptedActivity();
  }

  observeEncryptedWrapIds(owner: string, ids: Iterable<string>): void {
    if (this.owner !== owner) this.init(owner);
    const known = new Set(this.activity.known);
    const pending = new Set(this.activity.pending);
    for (const id of ids) {
      if (this.activity.initialized && !known.has(id)) pending.add(id);
      known.add(id);
    }
    const keptKnown = [...known].slice(-MAX_WRAP_IDS);
    const keptSet = new Set(keptKnown);
    this.activity = {
      initialized: true,
      known: keptKnown,
      pending: [...pending].filter((id) => keptSet.has(id)),
    };
    cacheSet(ACTIVITY_KEY, this.activity, undefined, owner);
  }

  acknowledgeEncryptedActivity(): void {
    if (!this.owner || this.activity.pending.length === 0) return;
    this.activity = { ...this.activity, pending: [] };
    cacheSet(ACTIVITY_KEY, this.activity, undefined, this.owner);
  }

  /**
   * Ciphertext-only inbox check. It runs only while the app shell is alive and
   * deliberately never receives or invokes a signer, so remote signers are not
   * prompted merely to produce a badge.
   */
  async pollEncryptedInbox(owner: string): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      // Observe only the recent inbox window. Paginated history is consumed by
      // fetchDms(), which retains the wraps for decryption; advancing that cursor
      // here would discard old ciphertext before the user opens Chat.
      const wraps = await scanDmGiftWraps(owner, { history: false });
      if (this.owner === owner) this.observeEncryptedWrapIds(owner, wraps.map((wrap) => wrap.id));
    })().finally(() => (this.polling = null));
    return this.polling;
  }
}

export const dmUnread = new DmUnreadStore();
