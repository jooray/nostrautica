/**
 * Bounds for the two signer-backed "which events are mine?" scans — the 30078
 * sweep in `recover.ts` and the gift-wrap sweep in `attendee.ts` — plus the
 * vocabulary Home needs to tell "your signer never answered" apart from "you
 * genuinely have no events".
 *
 * Why this module exists (incident 2026-07-28): an organizer logged in with
 * Amber and their events appeared to vanish. Both scans walked an UNBOUNDED
 * serial chain of NIP-46 decrypts — two round trips per gift wrap, each with a
 * 60s ceiling — and swallowed every failure, so Home saw two resolved promises
 * and an empty keystore and rendered "No events yet". A signer outage and an
 * empty account produced byte-identical UI. Bounding the chain here (so a slow
 * signer degrades to "partial") and reporting an outcome (so the caller can say
 * which of the two it is) are the same fix from two sides.
 */

/**
 * Wall-clock budget for one scan round, measured from the moment the scan
 * starts so the relay read counts against it too.
 *
 * Chosen from what the code already uses: the relay reads inside a pass cap at
 * 8s (`streamEvents`' default `timeoutMs`, and the explicit 8000 in
 * `social.ts` / `coordinators.ts`), and Home's spinner backstop is 12s. 10s
 * sits between them, so after even a worst-case relay read there is room for a
 * signer round trip or two, and the scan reports "partial, retry" on its own
 * before Home's backstop fires — the backstop stays a backstop rather than
 * becoming the normal exit.
 */
export const SCAN_BUDGET_MS = 10_000;

/**
 * Hard cap on signer round trips per scan round.
 *
 * The time budget alone does NOT bound a prompt storm: a remote signer that
 * answers quickly but asks the human to approve each decrypt can raise dozens
 * of prompts inside 10s, and prompts — not milliseconds — are what the user
 * actually experiences. 50 is the same order as the 50-entry `#d` filter chunk
 * the roster reads use: comfortably more than a normal account needs (a handful
 * of events, a few dozen wraps, most already memoized), and small enough that a
 * pathological mailbox degrades to "partial, retry" instead of an open-ended
 * chain of Amber dialogs.
 */
export const MAX_SIGNER_CALLS = 50;

/**
 * What a claimed round trip is FOR, which decides whether it may spend the last
 * of a shared allowance.
 *
 * `normal` is work that can hand this device a key it does not have: the 30078
 * backups in `recover.ts`, the 21602/21605 gift wraps in `attendee.ts`. `low` is
 * work that can only ever tell the user something — the 31602 membership sweep
 * in `membership.ts` reads records that contain no key material at all, so a
 * prompt it spends is a prompt a real recovery did not get.
 */
export type ScanPriority = "normal" | "low";

/**
 * Signer round trips held in reserve for `normal` work.
 *
 * Without this the three scans race for one pool and order decides the winner.
 * An account with thirty-odd spaces would spend the whole allowance decrypting
 * self-copies — records that prove membership and recover nothing — and the
 * grant scan would run out before it reached the wrap carrying the ECK the user
 * is actually missing. The reserve makes that impossible: `low` work sees a
 * smaller cap and stops early, so the scans that can restore custody always have
 * this many claims left however busy the membership sweep is.
 *
 * 20 of 50 because the two recovering scans are the ones with genuinely
 * unbounded input (a gift-wrap inbox is every DM and chat welcome ever sent to
 * this account), while the membership sweep's input is bounded by how many
 * spaces one person joined — and is memoized to nothing after its first pass.
 */
export const LOW_PRIORITY_RESERVE = 20;

export interface ScanBudget {
  /**
   * Claim one signer round trip. Returns false once either the time budget or
   * the call cap is spent — the caller must then stop walking and mark its
   * outcome truncated rather than starting another decrypt.
   *
   * A `low` claim is refused while fewer than {@link LOW_PRIORITY_RESERVE}
   * claims remain, so it can never take the last prompts from work that could
   * recover a key.
   */
  take(priority?: ScanPriority): boolean;
}

/**
 * Start a budget. Home shares ONE budget across all its scans so they cannot,
 * between them, spend more than the cap.
 */
export function startScanBudget(
  opts: {
    budgetMs?: number;
    maxCalls?: number;
    /** Claims withheld from `low` work; defaults to {@link LOW_PRIORITY_RESERVE}. */
    reserve?: number;
    now?: () => number;
  } = {},
): ScanBudget {
  const budgetMs = opts.budgetMs ?? SCAN_BUDGET_MS;
  const maxCalls = opts.maxCalls ?? MAX_SIGNER_CALLS;
  // Never negative: a caller that sets a cap below the reserve is asking for a
  // budget that does no low-priority work at all, not for one that wraps around.
  const reserve = Math.max(0, Math.min(opts.reserve ?? LOW_PRIORITY_RESERVE, maxCalls));
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  let spent = 0;
  return {
    take(priority: ScanPriority = "normal") {
      const cap = priority === "low" ? maxCalls - reserve : maxCalls;
      if (spent >= cap) return false;
      if (now() - startedAt >= budgetMs) return false;
      spent++;
      return true;
    },
  };
}

/** What one scan pass can say about itself afterwards. */
export interface ScanOutcome {
  /** Signer round trips this pass attempted. */
  attempted: number;
  /** …of which returned plaintext — proof the signer is actually answering. */
  succeeded: number;
  /** The pass stopped early because the shared budget ran out, or the relay read
   *  could not be walked to the end of the history. */
  truncated: boolean;
  /**
   * Key grants we hold, unwrapped, and could NOT act on because the event's
   * signed 31600 was unreachable from every relay this device knows.
   *
   * A count rather than a boolean because it is a fact about the user's account
   * ("2 events are waiting"), and because zero is the only value the UI should
   * stay quiet about. This branch used to `continue` in silence: the device had
   * the key grant in its hands on every single scan, could not open it, and Home
   * rendered "No events yet" with no hint that anything was being retried. It is
   * the difference between "you have no events" and "I can't reach that event's
   * relays", which are the two states this whole module exists to separate.
   */
  unreachableEvents: number;
}

export function emptyOutcome(): ScanOutcome {
  return { attempted: 0, succeeded: 0, truncated: false, unreachableEvents: 0 };
}

/**
 * True when a pass must NOT be read as "this is everything you have".
 *
 * Mirrors the rule both scanners already use to decide whether to remember that
 * they ran (`recover.ts`'s `meaningful`, `attendee.ts`'s backfill latch): a pass
 * that attempted signer work and got nothing back is a signer/transport outage,
 * not an empty account. A truncated pass simply didn't finish. Note what is NOT
 * degraded: a pass where some unwraps failed but at least one succeeded — the
 * signer is demonstrably answering and the failures are foreign/corrupt wraps,
 * which is the steady state for any gift-wrap inbox.
 */
export function scanIncomplete(o: ScanOutcome): boolean {
  return o.truncated || (o.attempted > 0 && o.succeeded === 0);
}

/**
 * The error Home shows when the scans came back but cannot be trusted as
 * complete. The wording is deliberately timeout-shaped so `categorizeError`
 * classifies it as `timeout` — "This is taking longer than expected. Try again
 * in a moment." is exactly the truth, and it reuses the existing ErrorState
 * vocabulary instead of inventing a category.
 */
export class ScanIncompleteError extends Error {
  constructor(message = "Timed out waiting for your signer to answer for every item.") {
    super(message);
    this.name = "ScanIncompleteError";
  }
}

/**
 * Reduce one scan round to the single thing the UI needs: the error to surface,
 * or null when the resulting list can be presented as authoritative.
 *
 * A rejection (the relay read failed) wins over a degraded outcome — it is the
 * more specific, more actionable message, and `categorizeError` can classify a
 * real error where it can only guess at a synthetic one.
 */
/**
 * How many events across a scan round are held-but-unopenable (see
 * {@link ScanOutcome.unreachableEvents}). Separate from {@link scanFailure}
 * because it is not a failure: the scan worked, the signer answered, and the
 * answer was "you have a key waiting for an event I can't reach". That deserves
 * its own sentence, not the generic retry error.
 */
export function unreachableEventCount(outcomes: ScanOutcome[]): number {
  return outcomes.reduce((n, o) => n + o.unreachableEvents, 0);
}

export function scanFailure(
  results: PromiseSettledResult<unknown>[],
  outcomes: ScanOutcome[],
): unknown {
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) return (rejected as PromiseRejectedResult).reason;
  if (outcomes.some(scanIncomplete)) return new ScanIncompleteError();
  return null;
}
