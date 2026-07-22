/**
 * Queued-publish visibility (audit UX-15, App-8). `publishOrQueue`
 * (nostr/publish-queue.ts) returns false when an event lands in the durable
 * outbox instead of going out, but nothing surfaced that anywhere — a join
 * request, follow, or DM sent on flaky venue Wi-Fi looked lost. This store keeps
 * a reactive view of the outbox so the shell can show a quiet "will sync" chip
 * and, for events that exhausted their retries, a terminal "failed" list the
 * user can retry or discard (App-8 permanent-failure policy).
 *
 * publish-queue.ts owns the storage + flush; this is a reactive observer over
 * its seam (`listQueued`) plus the two user actions (`retryFailed`,
 * `discardQueued`). `noteQueued()` lets a call site that just queued something
 * refresh the view immediately instead of waiting for the next poll.
 */
import {
  listQueued,
  retryFailed,
  discardQueued,
} from "$lib/nostr/publish-queue.js";

const POLL_MS = 30_000;

/** A terminal item shown in the outbox UI for retry/discard. */
export interface FailedOutboxItem {
  id: string;
  kind: number;
  queuedAt: number;
}

class Outbox {
  /** Non-terminal events sitting in the durable publish queue right now. */
  pending = $state(0);
  /** Events that exhausted their retries and await an explicit retry/discard. */
  failed = $state<FailedOutboxItem[]>([]);
  private started = false;
  private recountTimer: ReturnType<typeof setTimeout> | undefined;

  /** Begin observing the outbox (idempotent; safe to call from any component). */
  init(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    void this.refresh();
    // The queue flushes on reconnect — recount shortly after "online" so the
    // chip clears once the flush drained (and stays if it didn't).
    window.addEventListener("online", () => this.refreshSoon(2_000));
    setInterval(() => void this.refresh(), POLL_MS);
  }

  /** Recount now (best-effort, never throws). */
  async refresh(): Promise<void> {
    const items = await listQueued().catch(() => []);
    this.pending = items.filter((i) => !i.failed).length;
    this.failed = items
      .filter((i) => i.failed)
      .map((i) => ({ id: i.event.id, kind: i.event.kind, queuedAt: i.queuedAt }));
  }

  /** Recount shortly — coalesces bursts (e.g. several queued sends at once). */
  refreshSoon(delayMs = 750): void {
    if (this.recountTimer) return;
    this.recountTimer = setTimeout(() => {
      this.recountTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  /** A call site just queued something — reflect it without waiting for the poll. */
  noteQueued(): void {
    this.init();
    this.refreshSoon();
  }

  /** Revive a failed item and flush; then refresh the view. */
  async retry(id: string): Promise<void> {
    await retryFailed(id).catch(() => {});
    await this.refresh();
  }

  /** Permanently drop a failed (or pending) item; then refresh the view. */
  async discard(id: string): Promise<void> {
    await discardQueued(id).catch(() => {});
    await this.refresh();
  }
}

export const outbox = new Outbox();
