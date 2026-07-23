/**
 * Shared operation-status announcer (audit §7.3.9). Transient results of a
 * publish/save — Queued (offline, will send), Published (relay-confirmed), or
 * Coordinator acknowledged — were surfaced only as ephemeral toasts or a bare
 * outbox count, never announced and gone before assistive tech read them. This
 * store holds ONE current status and stays put until the user's next edit, so a
 * screen reader gets a stable, polite announcement and a sighted user a
 * persistent confirmation line.
 *
 * The reactive `.message` is rendered inside an `aria-live="polite"` region (see
 * OperationStatus.svelte). Call `queued/published/acknowledged/fail` from submit
 * paths; call `clearOnEdit()` from the form's input handlers.
 */

export type OpKind = "queued" | "published" | "acknowledged" | "error";

class OperationStatus {
  kind = $state<OpKind | null>(null);
  message = $state("");

  private set(kind: OpKind, message: string): void {
    this.kind = kind;
    this.message = message;
  }

  /** Saved locally; will publish when back online. */
  queued(message: string): void {
    this.set("queued", message);
  }

  /** Confirmed accepted by at least one relay. */
  published(message: string): void {
    this.set("published", message);
  }

  /** The coordinator acknowledged receipt (submission/talk/status). */
  acknowledged(message: string): void {
    this.set("acknowledged", message);
  }

  /** A publish/save failed. */
  fail(message: string): void {
    this.set("error", message);
  }

  clear(): void {
    this.kind = null;
    this.message = "";
  }

  /** Drop the status when the user starts editing again (next-edit lifetime). */
  clearOnEdit(): void {
    if (this.kind !== null) this.clear();
  }
}

export const opStatus = new OperationStatus();
