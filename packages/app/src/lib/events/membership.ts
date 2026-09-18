/**
 * "Which spaces did this account ever ask to join?", answered from the NETWORK
 * rather than from this device's key store (audit E9).
 *
 * Every other answer the app has to that question is really an answer to a
 * different one — "which spaces can this device open?" — and the two come apart
 * badly. An attendee's ECK exists on the wire in exactly ONE place: the one-shot
 * kind-21602 gift wrap sent at approval. There is no attendee-side self-backup,
 * the way `recover.ts` has one for an organizer. So when that wrap is genuinely
 * gone (relay retention, or a relay set that never overlapped the one it was
 * delivered to) the event is unrecoverable AND invisible: Home renders "Nothing
 * here yet", which is byte-identical to never having joined anything. The user
 * is told, with total confidence, that a thing they remember doing did not
 * happen.
 *
 * There is a second record of the join on the wire, and it has been there all
 * along. `join.ts` publishes a kind-31602 self-copy, authored by the ATTENDEE,
 * self-encrypted, carrying `a: <coordinate>` — the attendee's own queryable copy
 * of what they submitted. Today it is only ever read with a `#d` you must
 * already know (`loadSelfCopy`), which means it can only confirm a membership
 * you had already established. Enumerating it by author and kind instead yields
 * every space this identity ever asked to join, on any device holding the nsec,
 * with no time window at all.
 *
 * This is a READ of a record the protocol already defines. No new kind, no new
 * tag, nothing added to the wire — `docs/PROTOCOL-NIP.md` is untouched by it.
 *
 * What it does NOT do is recover a key: the self-copy holds the attendee's own
 * profile and media, never the ECK. Discovery and recovery are different jobs,
 * and this one exists so the app can say "you joined this, the key has not
 * reached this device" instead of saying nothing.
 */
import { KIND_MY_PROFILE, isEventCoordinate } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import type { EventKeys } from "./keystore.js";
import {
  startScanBudget,
  emptyOutcome,
  type ScanBudget,
  type ScanOutcome,
} from "./scan-budget.js";

/** A space this identity has, at some point, published a join self-copy for. */
export interface DiscoveredMembership {
  /** The `a` coordinate the self-copy names. Carries its own kind (31923 or 31612). */
  coordinate: string;
  /** `created_at` of the self-copy that proves it, in seconds. */
  at: number;
}

/** Cap on the persisted self-copy memo, mirroring recover.ts's backup memo. */
export const MAX_REMEMBERED_SELF_COPIES = 2000;

/**
 * Per-31602 memo (owner-scoped, persisted), the same device as recover.ts's.
 *
 * Unlike that one it remembers the ANSWER, not merely "seen": this scan's whole
 * output is the coordinate list, so a memo that only said "already read" would
 * force a re-decrypt of every self-copy on every pass to rebuild it. Mapping id
 * → coordinate lets a steady-state pass cost zero signer round trips and still
 * return the full list — which is the difference between a scan a NIP-46 user
 * can afford to run on every Home mount and one they cannot.
 *
 * The empty string is the definitive negative: a 31602 we DID decrypt that named
 * no usable coordinate. It is remembered so we never pay for it twice; a failed
 * DECRYPT is not remembered at all, since that is what an unreachable Amber
 * looks like.
 *
 * A 31602 is addressable, so an edited self-copy is a new event id — memoizing
 * by id can never pin a stale record.
 */
const SELF_COPY_MEMO_KEY = "joinselfcopies";

function loadMemo(): Record<string, string> {
  return { ...(cacheGet<Record<string, string>>(SELF_COPY_MEMO_KEY)?.data ?? {}) };
}

function saveMemo(memo: Record<string, string>): void {
  const keys = Object.keys(memo);
  if (keys.length > MAX_REMEMBERED_SELF_COPIES) {
    const keep = new Set(keys.slice(-MAX_REMEMBERED_SELF_COPIES));
    for (const k of keys) if (!keep.has(k)) delete memo[k];
  }
  cacheSet(SELF_COPY_MEMO_KEY, memo, Math.floor(Date.now() / 1000));
}

/**
 * Every space this identity published a join self-copy for, newest first.
 *
 * Bounded like the other two scans (`scan-budget.ts`) and deliberately LOW
 * priority within the shared allowance: nothing here can restore custody, so it
 * must never spend the prompts that `receiveGrants` needs to open a key grant.
 * See {@link ScanPriority}.
 *
 * Relay-only, like the grant read and like `loadSelfCopy`: the point of this
 * scan is to learn something the local caches by definition do not know, and the
 * dexie adapter can EOSE-resolve a fetch before a record that already arrived is
 * surfaced.
 */
export async function discoverJoinedSpaces(
  signer: AppSigner,
  opts: { budget?: ScanBudget; onOutcome?: (outcome: ScanOutcome) => void } = {},
): Promise<DiscoveredMembership[]> {
  const pubkey = await signer.getPublicKey();
  const budget = opts.budget ?? startScanBudget();
  const outcome = emptyOutcome();
  const memo = loadMemo();
  let memoDirty = false;
  try {
    const events = await fetchEventsRelayOnly(
      { kinds: [KIND_MY_PROFILE], authors: [pubkey] },
      DEFAULT_RELAYS,
    );

    const found = new Map<string, number>();
    const note = (coordinate: string, at: number) => {
      const prior = found.get(coordinate);
      if (prior === undefined || at > prior) found.set(coordinate, at);
    };

    // NEWEST FIRST, for the same reason recover.ts orders its backups: the
    // decrypt is what the budget rations, so a truncated pass should have spent
    // its allowance on the most recent joins — the ones a user is most likely to
    // be looking for right now.
    //
    // The author filter is re-checked locally because a relay is free to ignore
    // it. The decrypt below is self-authenticating anyway (a record we did not
    // seal to ourselves will not open), so this only saves a wasted round trip.
    const ordered = [...events]
      .filter((e) => e.pubkey === pubkey)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    for (const e of ordered) {
      const at = e.created_at ?? 0;
      const remembered = memo[e.id];
      if (remembered !== undefined) {
        if (remembered) note(remembered, at);
        continue;
      }
      // Out of time, out of prompts, or down to the reserve that belongs to the
      // scans which can actually recover a key. Stop rather than start another
      // decrypt: nothing here is memoized as a negative, so the next pass simply
      // resumes.
      if (!budget.take("low")) {
        outcome.truncated = true;
        break;
      }
      outcome.attempted++;
      let plaintext: string;
      try {
        plaintext = await signer.nip44Decrypt(pubkey, e.content);
      } catch {
        // Signer not ready / not ours / undecryptable. NOT definitive — this is
        // exactly the shape of an Amber that has not been approved yet, and
        // memoizing it would teach the device to stop asking.
        continue;
      }
      outcome.succeeded++;
      let coordinate = "";
      try {
        const a = (JSON.parse(plaintext) as { a?: unknown }).a;
        // `isEventCoordinate` accepts BOTH space kinds (31923 and 31612), so a
        // community discovered this way is treated exactly like an event. The
        // coordinate carries its own kind; nothing downstream may assume 31923.
        if (typeof a === "string" && isEventCoordinate(a)) coordinate = a;
      } catch {
        /* decrypted but malformed — definitive, memoized below as a negative */
      }
      memo[e.id] = coordinate;
      memoDirty = true;
      if (coordinate) note(coordinate, at);
    }
    if (memoDirty) saveMemo(memo);

    return [...found]
      .map(([coordinate, at]) => ({ coordinate, at }))
      .sort((a, b) => b.at - a.at);
  } finally {
    opts.onOutcome?.(outcome);
  }
}

/**
 * The spaces the network says this identity joined that this device cannot
 * open: discovered on the wire, no usable ECK in the local key store.
 *
 * Pure, because it is the sentence Home renders and the one thing that must not
 * be wrong in either direction. A false positive tells someone an event is
 * broken when they can already read it; a false negative puts them back in front
 * of "Nothing here yet".
 *
 * A key-store record with an EMPTY `eck` list counts as unopenable, not as held.
 * That state is real — `applyOrganizerGrant` and `addEckVersions` both write a
 * record before any ECK version necessarily lands in it — and it is precisely
 * the "I know about this event and cannot read a thing in it" case this list
 * exists to name.
 */
export function awaitingKey(
  discovered: DiscoveredMembership[],
  held: Pick<EventKeys, "coordinate" | "eck">[],
): DiscoveredMembership[] {
  const openable = new Set(
    held.filter((k) => (k.eck?.length ?? 0) > 0).map((k) => k.coordinate),
  );
  return discovered.filter((d) => !openable.has(d.coordinate));
}
