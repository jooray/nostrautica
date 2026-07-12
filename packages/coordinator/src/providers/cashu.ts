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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  getDecodedToken,
  type Proof,
} from "@cashu/cashu-ts";
import type { PaymentStrategy } from "./types.js";

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
}

export class CashuPayment implements PaymentStrategy {
  private wallet: CashuWallet;
  private loaded = false;

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
    writeFileSync(this.opts.walletDbPath, JSON.stringify(file, null, 2));
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
    file.proofs = keep;
    this.save(file);

    const token = getEncodedTokenV4({ mint: this.opts.mintUrl, proofs: send });
    return this.opts.mode === "balance"
      ? { Authorization: `Bearer ${token}` }
      : { "X-Cashu": token };
  }

  async settle(responseHeaders: Headers): Promise<void> {
    const changeToken = responseHeaders.get("X-Cashu");
    if (!changeToken) return;
    await this.ensureLoaded();
    try {
      const decoded = getDecodedToken(changeToken);
      const received = await this.wallet.receive(decoded);
      const file = this.load();
      file.proofs = [...file.proofs, ...received];
      this.save(file);
    } catch {
      // Malformed / already-spent change — nothing to bank.
    }
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
