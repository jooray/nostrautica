/**
 * Cashu payment strategy for Routstr (spec §9.4, v2). Two modes:
 *  - balance: `Authorization: Bearer <cashu-token>` — the node converts it to an
 *    sk- key and bills against it.
 *  - stateless per-request: `X-Cashu: <token>` per call, with change returned in
 *    the `X-Cashu` RESPONSE header — settle() must persist the change proofs.
 *
 * Wallet state is persisted to a JSON file (proofs). The operator experience:
 * fund the coordinator with Cashu tokens, pick a node + model, done.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  getDecodedToken,
  type Proof,
} from "@cashu/cashu-ts";
import type { PaymentReservation, PaymentStrategy } from "./types.js";
import type { Store } from "../store/db.js";

interface WalletFile {
  mint: string;
  proofs: Proof[];
}

export interface CashuPaymentOptions {
  mintUrl: string;
  walletDbPath: string;
  /** sats to send per request when no token estimate is available. */
  defaultAmountSats?: number;
  /** Balance mode sends the whole token as a Bearer key instead of per-request. */
  mode?: "stateless" | "balance";
  /**
   * Durable payment journal (audit finding H8). When provided, every reservation
   * is recorded before its proofs leave the wallet, so a crash between send and
   * settle can never silently lose or double-spend proofs. Omit only in balance
   * mode, where the whole token is a long-lived Bearer key (no per-request change).
   */
  journal?: Store;
}

export class CashuPayment implements PaymentStrategy {
  private wallet: CashuWallet;
  private loaded = false;
  /** The reservation the LEGACY prepare()/settle()/fail() trio is tracking. */
  private pendingRequestId?: string;
  /**
   * Serialises every load → await → save of the wallet file (audit R-49). Two
   * overlapping sections each read the same proofs, and the later save drops the
   * earlier one's swap change. A section abandoned by its caller's deadline keeps
   * the lock until its mint call actually ends, which is the point: the work is
   * still running, so the next one must wait for it.
   */
  private walletLock: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.walletLock.then(fn, fn);
    this.walletLock = run.catch(() => {});
    return run;
  }

  constructor(private readonly opts: CashuPaymentOptions) {
    this.wallet = new CashuWallet(new CashuMint(opts.mintUrl));
  }

  private load(): WalletFile {
    const path = this.opts.walletDbPath;
    if (!existsSync(path)) return { mint: this.opts.mintUrl, proofs: [] };
    try {
      return JSON.parse(readFileSync(path, "utf8")) as WalletFile;
    } catch (e) {
      // Never fall back to an empty wallet here: the next save() would overwrite
      // the only copy of the retained proofs (audit R-51). Stop, and say where.
      throw new Error(
        `cashu wallet file ${path} is unreadable (${e instanceof Error ? e.message : e}); ` +
          "it holds bearer proofs, so fix or restore it by hand before retrying",
      );
    }
  }
  private save(file: WalletFile): void {
    // Temp file + fsync + rename (audit R-51). The wallet file is the ONLY copy of
    // the retained `keep` proofs — the journal covers proofs that left it — so a
    // truncating in-place write interrupted by a crash or a full disk stranded the
    // whole balance. rename() replaces the target atomically within the directory.
    // Bearer money at rest: owner-read/write only (audit COORD-5).
    const path = this.opts.walletDbPath;
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true }); // a leftover from a crash may carry another mode
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(file, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    try {
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir); // make the rename itself durable
      } finally {
        closeSync(dir);
      }
    } catch {
      // Not every platform can fsync a directory; the data file is already synced.
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.wallet.loadMint();
      this.loaded = true;
    }
  }

  /**
   * One request's payment, with its own settle()/fail() (audit R-49). Prefer this
   * over prepare(): the reservation id travels with the handle, so a prepare that
   * completes after its caller gave up can never be settled by the next request.
   */
  async reserve(req: { estimateTokens?: number }): Promise<PaymentReservation> {
    const { headers, requestId } = await this.exclusive(() => this.reserveLocked(req));
    return {
      headers,
      settle: (h) => this.settleReservation(requestId, h),
      fail: async () => this.failReservation(requestId),
    };
  }

  private async reserveLocked(req: {
    estimateTokens?: number;
  }): Promise<{ headers: Record<string, string>; requestId?: string }> {
    await this.ensureLoaded();
    const file = this.load();
    const amount = Math.max(1, this.opts.defaultAmountSats ?? Math.ceil((req.estimateTokens ?? 1000) / 1000));

    // Select proofs worth `amount`; keep the change locally.
    const { keep, send } = await this.wallet.send(amount, file.proofs);

    // Durably journal the reservation BEFORE the proofs leave the wallet, so a
    // crash before settle() leaves an accountable `in_flight` record instead of a
    // silent loss (audit H8). Balance mode reuses one long-lived token, so there's
    // no per-request change to journal.
    let requestId: string | undefined;
    if (this.opts.journal && this.opts.mode !== "balance") {
      requestId = randomUUID();
      this.opts.journal.cashuReserve(requestId, this.opts.mintUrl, amount, send);
    }
    file.proofs = keep;
    this.save(file);

    const token = getEncodedTokenV4({ mint: this.opts.mintUrl, proofs: send });
    const headers: Record<string, string> =
      this.opts.mode === "balance" ? { Authorization: `Bearer ${token}` } : { "X-Cashu": token };
    return { headers, requestId };
  }

  async prepare(req: { estimateTokens?: number }): Promise<Record<string, string>> {
    const { headers, requestId } = await this.exclusive(() => this.reserveLocked(req));
    this.pendingRequestId = requestId;
    return headers;
  }

  async settle(responseHeaders: Headers): Promise<void> {
    const requestId = this.pendingRequestId;
    this.pendingRequestId = undefined;
    await this.settleReservation(requestId, responseHeaders);
  }

  private async settleReservation(requestId: string | undefined, responseHeaders: Headers): Promise<void> {
    // settle() is only reached after the provider accepted the payment (res.ok),
    // so the reserved proofs are now spent; bank any returned change.
    const changeToken = responseHeaders.get("X-Cashu");

    let banked: Proof[] = [];
    if (changeToken) {
      await this.exclusive(async () => {
        await this.ensureLoaded();
        try {
          const decoded = getDecodedToken(changeToken);
          // Journal the change proofs BEFORE redeeming them into the wallet file
          // (audit COORD-5): a crash mid-receive then leaves the change accounted
          // for in the durable journal instead of lost with the token string.
          const changeProofs = (decoded.proofs ?? []) as Proof[];
          if (requestId && this.opts.journal && changeProofs.length > 0) {
            this.opts.journal.cashuSettle(requestId, changeProofs);
          }
          banked = await this.wallet.receive(decoded);
          const file = this.load();
          file.proofs = [...file.proofs, ...banked];
          this.save(file);
        } catch {
          // Malformed / already-spent change — nothing to bank in the wallet; any
          // change proofs journaled above stay recoverable there (COORD-5).
        }
      });
    }
    // Close out the journal reservation (request completed). Idempotent: when the
    // change was already journaled above this is a no-op; it also covers the
    // no-change case (settled with empty change).
    if (requestId && this.opts.journal) {
      this.opts.journal.cashuSettle(requestId, banked);
    }
  }

  /**
   * The request failed after prepare() (audit COORD-5): settle() will never run
   * for this reservation. Whether the node redeemed the proofs is unknowable
   * locally (a network error may or may not have reached it), so quarantine the
   * reservation as `ambiguous` — the proofs stay recorded in the journal (not
   * lost) and are never re-credited to the wallet (no double-spend).
   */
  async fail(): Promise<void> {
    const requestId = this.pendingRequestId;
    this.pendingRequestId = undefined;
    this.failReservation(requestId);
  }

  private failReservation(requestId: string | undefined): void {
    if (requestId && this.opts.journal) {
      this.opts.journal.cashuMarkAmbiguous(requestId);
    }
  }

  /**
   * Reconcile the journal after a restart (audit H8): any reservation still
   * `in_flight` was interrupted between send and settle. We can't know locally
   * whether the mint spent the proofs, so quarantine it as `ambiguous` — the
   * proofs are neither lost (they stay recorded in the journal) nor re-added to
   * the wallet (no double-spend). An operator/mint check can later resolve them.
   * Returns the number of reservations quarantined.
   */
  reconcileJournal(): number {
    if (!this.opts.journal) return 0;
    const pending = this.opts.journal.cashuNonterminal();
    let quarantined = 0;
    for (const entry of pending) {
      if (entry.state === "in_flight") {
        this.opts.journal.cashuMarkAmbiguous(entry.request_id);
        quarantined++;
      }
    }
    return quarantined;
  }

  /** Import a Cashu token to fund the wallet (operator top-up). */
  async fund(token: string): Promise<number> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const received = await this.wallet.receive(getDecodedToken(token));
      const file = this.load();
      file.proofs = [...file.proofs, ...received];
      this.save(file);
      return file.proofs.reduce((sum, p) => sum + p.amount, 0);
    });
  }
}
