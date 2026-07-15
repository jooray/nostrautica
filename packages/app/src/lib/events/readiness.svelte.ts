/**
 * Readiness store (redesign §4.1). Gathers the derivation inputs from real state
 * — approval/role, backup ack, the 31602 self-copy (intro), the own 31603
 * directory entry (processing), and the 31605 match list — and exposes a
 * reactive `Readiness`. Every fetch failure maps to an `undefined` input, never
 * a thrown error on the Overview.
 *
 * A per-coordinate monotonic latch (in-memory Map, NOT persisted) makes a
 * finished step stay "complete" even when a later refresh can't confirm it
 * offline — the model itself stays derived.
 */
import {
  deriveReadiness,
  type Readiness,
  type ReadinessInput,
  type ReadinessStepId,
} from "./readiness.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import { isApproved, fetchDirectoryEntry, fetchMatches } from "./attendee.js";
import { loadEventKeys } from "./keystore.js";
import { joinSentAt } from "$lib/stores/join-sent.svelte.js";
import { backupNag } from "$lib/stores/backup-nag.svelte.js";
import { deriveBlindingKey } from "./blinding.js";
import { loadSelfCopy } from "$lib/media/submit.js";
import { online } from "$lib/stores/online.svelte.js";

type Role = "visitor" | "pending" | "attendee" | "organizer";

class ReadinessStore {
  readiness = $state<Readiness | undefined>(undefined);
  loading = $state(false);
  private latch = new Map<string, Set<ReadinessStepId>>();
  private token = 0;

  private latchFor(coord: string): Set<ReadinessStepId> {
    let s = this.latch.get(coord);
    if (!s) {
      s = new Set();
      this.latch.set(coord, s);
    }
    return s;
  }

  reset(): void {
    this.token++;
    this.readiness = undefined;
    this.loading = false;
  }

  async load(ctx: EventContext, signer: AppSigner | null): Promise<void> {
    const tok = ++this.token;
    this.loading = true;
    try {
      const coord = ctx.coordinate;
      const approved = await isApproved(coord).catch(() => false);
      const keys = await loadEventKeys(coord).catch(() => undefined);
      const organizer = keys?.role === "organizer";
      const role: Role = organizer
        ? "organizer"
        : approved
          ? "attendee"
          : joinSentAt(coord) !== undefined
            ? "pending"
            : "visitor";
      const isMember = role === "attendee" || role === "organizer";

      let hasIntro: boolean | undefined;
      let processed: boolean | undefined;
      let matchesAvailable: boolean | undefined;

      if (isMember && signer) {
        try {
          const bk = await deriveBlindingKey(signer);
          const self = await loadSelfCopy(signer, ctx, bk);
          hasIntro = (self?.media ?? []).some((m) => m.kind === "intro");
        } catch {
          hasIntro = undefined; // couldn't tell — model shows "Checking status"
        }

        if (ctx.config.coordinator) {
          try {
            const pubkey = await signer.getPublicKey();
            const entry = await fetchDirectoryEntry(ctx, pubkey);
            // A directory entry with an ai_profile means processing finished; an
            // entry without one (or an intro submitted but not yet in the
            // directory) means it's still in progress.
            processed = entry ? !!entry.ai_profile : hasIntro ? false : undefined;
          } catch {
            processed = undefined;
          }
          if (ctx.config.matching === "on") {
            try {
              const list = await fetchMatches(signer, ctx);
              matchesAvailable = !!list;
            } catch {
              matchesAvailable = undefined;
            }
          }
        }
      }

      if (tok !== this.token) return;

      const input: ReadinessInput = {
        naddr: ctx.naddr,
        role,
        signerMethod: signer?.method,
        // TODO(P0.2): swap to the authenticated durable-backup status when it lands.
        backupAcked: backupNag.done,
        hasIntro,
        processed,
        matchesAvailable,
        matchingEnabled: ctx.config.matching === "on",
        hasCoordinator: !!ctx.config.coordinator,
        online: online.isOnline,
        latched: this.latchFor(coord),
      };
      const derived = deriveReadiness(input);
      const latch = this.latchFor(coord);
      for (const s of derived.steps) if (s.state === "complete") latch.add(s.id);
      this.readiness = derived;
    } finally {
      if (tok === this.token) this.loading = false;
    }
  }
}

export const readinessStore = new ReadinessStore();
