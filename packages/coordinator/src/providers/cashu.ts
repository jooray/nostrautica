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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  getDecodedToken,
  type Proof,
} from "@cashu/cashu-ts";
import type { PaymentStrategy } from "./types.js";
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
  /** The reservation awaiting settle() for this in-flight request, if any. */
  private pendingRequestId?: string;

  constructor(private readonly opts: CashuPaymentOptions) {
    this.wallet = new CashuWallet(new CashuMint(opts.mintUrl));
  }

  private load(): WalletFile {
    if (existsSync(this.opts.walletDbPath)) {
      return JSON.parse(readFileSync(this.opts.walletDbPath, "utf8")) as WalletFile;
    }
    return { mint: this.opts.mintUrl, proofs: [] };
  }
  private save(file: WalletFile): void {
    // Bearer money at rest: owner-read/write only (audit COORD-5).
    writeFileSync(this.opts.walletDbPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.wallet.loadMint();
      this.loaded = true;
    }
  }

  async prepare(req: { estimateTokens?: number }): Promise<Record<string, string>> {
    await this.ensureLoaded();
    const file = this.load();
    const amount = Math.max(1, this.opts.defaultAmountSats ?? Math.ceil((req.estimateTokens ?? 1000) / 1000));

    // Select proofs worth `amount`; keep the change locally.
    const { keep, send } = await this.wallet.send(amount, file.proofs);

    // Durably journal the reservation BEFORE the proofs leave the wallet, so a
    // crash before settle() leaves an accountable `in_flight` record instead of a
    // silent loss (audit H8). Balance mode reuses one long-lived token, so there's
    // no per-request change to journal.
    if (this.opts.journal && this.opts.mode !== "balance") {
      const requestId = randomUUID();
      this.opts.journal.cashuReserve(requestId, this.opts.mintUrl, amount, send);
      this.pendingRequestId = requestId;
    }
    file.proofs = keep;
    this.save(file);

    const token = getEncodedTokenV4({ mint: this.opts.mintUrl, proofs: send });
    return this.opts.mode === "balance"
      ? { Authorization: `Bearer ${token}` }
      : { "X-Cashu": token };
  }

  async settle(responseHeaders: Headers): Promise<void> {
    // settle() is only reached after the provider accepted the payment (res.ok),
    // so the reserved proofs are now spent; bank any returned change.
    const requestId = this.pendingRequestId;
    this.pendingRequestId = undefined;
    const changeToken = responseHeaders.get("X-Cashu");

    let banked: Proof[] = [];
    if (changeToken) {
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
    await this.ensureLoaded();
    const received = await this.wallet.receive(getDecodedToken(token));
    const file = this.load();
    file.proofs = [...file.proofs, ...received];
    this.save(file);
    return file.proofs.reduce((sum, p) => sum + p.amount, 0);
  }
}
