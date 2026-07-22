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
import { hasDurableKeyBackup } from "./key-backup.js";
import { deriveBlindingKey } from "./blinding.js";
import { loadSelfCopy, hasIntro as hasIntroFrom } from "$lib/media/submit.js";
import { online } from "$lib/stores/online.svelte.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

type Role = "visitor" | "pending" | "attendee" | "organizer";

// Persist the last derived readiness + the monotonic latch per coordinate
// (owner-scoped, CACHING-PLAN §2.7) so the journey widget paints instantly on
// reload and a finished step never regresses across sessions.
interface PersistedReadiness {
  readiness: Readiness;
  latched: ReadinessStepId[];
}
function readinessKey(coordinate: string): string {
  return `readiness:${coordinate}`;
}

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
    const coord = ctx.coordinate;
    // Paint the last derived readiness synchronously before the (many) network
    // fetches, and re-seat the monotonic latch from the persisted set (§2.7).
    const cached = cacheGet<PersistedReadiness>(readinessKey(coord))?.data;
    if (cached) {
      this.readiness = cached.readiness;
      const latch = this.latchFor(coord);
      for (const id of cached.latched) latch.add(id);
    }
    try {
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

      // "Backup secured" is honest: for a local key it reflects a DURABLE,
      // relay-persisted backup marker (recoverable on a fresh device), not the
      // transient dismiss-nag. Remote signers (nip07/nip46) hold the key
      // themselves — deriveReadiness treats that as secured via `signerMethod`.
      let backupAcked: boolean;
      if (signer?.method === "local") {
        backupAcked = await hasDurableKeyBackup(signer).catch(() => false);
      } else {
        backupAcked = backupNag.done;
      }

      let hasIntro: boolean | undefined;
      let processed: boolean | undefined;
      let matchesAvailable: boolean | undefined;

      if (isMember && signer) {
        try {
          const bk = await deriveBlindingKey(signer);
          const self = await loadSelfCopy(signer, ctx, bk);
          // An intro can be a recording (media kind "intro") OR a text intro (F1).
          hasIntro = hasIntroFrom(self);
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
        backupAcked,
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
      // Persist the freshly derived readiness + latch (§2.7).
      cacheSet(
        readinessKey(coord),
        { readiness: derived, latched: [...latch] } satisfies PersistedReadiness,
        Math.floor(Date.now() / 1000),
      );
    } finally {
      if (tok === this.token) this.loading = false;
    }
  }
}

export const readinessStore = new ReadinessStore();
