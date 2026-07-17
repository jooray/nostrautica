/**
 * Payment strategies (spec §9.4). v1 is a static API key (Venice, Bearer token).
 * v2 CashuPayment (Routstr) lands in P6 behind a config flag.
 */
import type { PaymentStrategy } from "./types.js";

/** v1: a static API key sent as `Authorization: Bearer <key>`. */
export class ApiKeyPayment implements PaymentStrategy {
  constructor(private readonly apiKey: string) {}

  async prepare(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async settle(): Promise<void> {
    // Nothing to settle for a static key.
  }
}

/** No-op payment (for local providers / tests). */
export class NoPayment implements PaymentStrategy {
  async prepare(): Promise<Record<string, string>> {
    return {};
  }
  async settle(): Promise<void> {}
}
