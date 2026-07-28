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

export interface ScanBudget {
  /**
   * Claim one signer round trip. Returns false once either the time budget or
   * the call cap is spent — the caller must then stop walking and mark its
   * outcome truncated rather than starting another decrypt.
   */
  take(): boolean;
}

/**
 * Start a budget. Home shares ONE budget across both scans so the pair cannot,
 * between them, spend twice the cap.
 */
export function startScanBudget(
  opts: { budgetMs?: number; maxCalls?: number; now?: () => number } = {},
): ScanBudget {
  const budgetMs = opts.budgetMs ?? SCAN_BUDGET_MS;
  const maxCalls = opts.maxCalls ?? MAX_SIGNER_CALLS;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  let spent = 0;
  return {
    take() {
      if (spent >= maxCalls) return false;
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
  /** The pass stopped early because the shared budget ran out. */
  truncated: boolean;
}

export function emptyOutcome(): ScanOutcome {
  return { attempted: 0, succeeded: 0, truncated: false };
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
export function scanFailure(
  results: PromiseSettledResult<unknown>[],
  outcomes: ScanOutcome[],
): unknown {
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) return (rejected as PromiseRejectedResult).reason;
  if (outcomes.some(scanIncomplete)) return new ScanIncompleteError();
  return null;
}
