/**
 * Latest-event rule (NIP §3.1). For any two events sharing (kind, author, `d`),
 * the one with the HIGHER `created_at` wins; on a tie, the one with the
 * lexicographically LOWEST `id` wins (the NIP-01 convention). Every reader — app
 * and coordinator, fetch and stream — MUST apply exactly this rule so two
 * conforming implementations never disagree about which replaceable event is
 * current. v1 had no app-side tie-break and the coordinator's only tie-break
 * picked the HIGHEST id; both are superseded here.
 */
export interface OrderableEvent {
  id: string;
  created_at?: number;
}

/**
 * NIP §3.1 comparator with Array.sort semantics: the event that should be treated
 * as CURRENT sorts FIRST (negative when `a` wins). Higher `created_at` first;
 * on a tie the lexicographically lowest `id` first.
 */
export function compareLatest(a: OrderableEvent, b: OrderableEvent): number {
  const ca = a.created_at ?? 0;
  const cb = b.created_at ?? 0;
  if (ca !== cb) return cb - ca; // higher created_at wins → sorts first
  if (a.id < b.id) return -1; // tie: lowest id wins → sorts first
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * True when `candidate` supersedes `current` under §3.1 — i.e. it is strictly
 * newer, or same-`created_at` with a lower `id`. A candidate with the same id
 * (a re-delivery of the same event) does NOT supersede. This is the primitive
 * every per-`d` / per-pubkey dedupe map should use to decide replacement.
 */
export function supersedes(candidate: OrderableEvent, current: OrderableEvent): boolean {
  return compareLatest(candidate, current) < 0;
}

/** The single latest event from a list under §3.1, or undefined when empty. */
export function pickLatest<T extends OrderableEvent>(events: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const e of events) if (!best || supersedes(e, best)) best = e;
  return best;
}

/**
 * Ordering key of a revisioned mutable submission (NIP §3.3): an explicit
 * application `rev` is the primary key, then the sender-chosen `created_at`, then
 * the rumor `id` — sender timestamps are never the primary ordering key.
 */
export interface RevisionKey {
  rev: number;
  created_at: number;
  /** The rumor id (used only as the final, deterministic tie-break). */
  id: string;
}

/**
 * The §3.3 total order for revisioned mutable submissions (21601 profile, 21608
 * correction): higher `rev` wins; equal `rev` → higher `created_at` wins; equal
 * both → the lexicographically LOWEST rumor id wins. Returns true when
 * `candidate` STRICTLY supersedes `current`; a loser OR an exactly-equal key
 * returns false, so a stale (or identical re-delivered) submission is never
 * applied over the stored one.
 */
export function revisionSupersedes(candidate: RevisionKey, current: RevisionKey): boolean {
  if (candidate.rev !== current.rev) return candidate.rev > current.rev;
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at;
  return candidate.id < current.id;
}
