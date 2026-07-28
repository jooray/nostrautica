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
 *
 * TWO PHASES (see `primeLocal` / `load`). Every input except three is already on
 * this device: custody comes from the keystore, the intro from the owner-scoped
 * self-copy cache. Deriving the card used to wait behind a full gift-wrap grant
 * sweep and then a fresh 31602 fetch (an Amber prompt, on every visit), so the
 * one widget that tells the user what to do next was the last thing on the page
 * to appear. The local phase paints immediately; the network phase refines it.
 *
 * NEVER DERIVE WITHOUT AN IDENTITY. Custody, approval and the self-copy cache
 * are all owner-scoped, so with no signer they all answer "no" and the
 * derivation lands on "visitor — you need to join". For a user whose NIP-46
 * session is still restoring in the background (routes/+layout.svelte does not
 * await it) that answer is a lie about the person most likely to be looking at
 * the page: the event's own organizer.
 */
import {
  deriveReadiness,
  type Readiness,
  type ReadinessInput,
  type ReadinessStepId,
} from "./readiness.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchDirectoryEntry, fetchMatches } from "./attendee.js";
import { loadEventKeys, currentEck, type EventKeys } from "./keystore.js";
import { joinSentAt } from "$lib/stores/join-sent.svelte.js";
import { backupNag } from "$lib/stores/backup-nag.svelte.js";
import { hasDurableKeyBackup } from "./key-backup.js";
import { deriveBlindingKey } from "./blinding.js";
import {
  loadSelfCopy,
  cachedSelfCopy,
  hasIntro as hasIntroFrom,
} from "$lib/media/submit.js";
import { online } from "$lib/stores/online.svelte.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

type Role = ReadinessInput["role"];

/** The inputs the store gathers; everything else in ReadinessInput is from ctx. */
type Gathered = Pick<
  ReadinessInput,
  "role" | "backupAcked" | "hasIntro" | "processed" | "matchesAvailable"
>;

// Persist the last derived readiness + the monotonic latch per coordinate
// (owner-scoped, CACHING-PLAN §2.7) so the journey widget paints instantly on
// reload and a finished step never regresses across sessions.
interface PersistedReadiness {
  /**
   * Schema/trust version. Bumped to 2 because v1 entries can be POISONED: the
   * store used to derive and persist a full "visitor, must join" snapshot from
   * an identity that hadn't finished arriving, and it wrote an empty `latched`
   * alongside it — wiping the very latch that exists to stop a completed step
   * from regressing. Those entries paint synchronously on every later visit, so
   * they must be ignored rather than migrated.
   */
  v: number;
  readiness: Readiness;
  latched: ReadinessStepId[];
}
const PERSIST_VERSION = 2;

function readinessKey(coordinate: string): string {
  return `readiness:${coordinate}`;
}

/**
 * Role from a custody read that SUCCEEDED. `keys === undefined` here means the
 * read worked and this identity holds nothing — callers must never pass the
 * `undefined` of a read that threw (that's `role: "unknown"`, see the store).
 */
function roleFrom(keys: EventKeys | undefined, coordinate: string): Role {
  if (keys?.role === "organizer") return "organizer";
  if (currentEck(keys)) return "attendee";
  return joinSentAt(coordinate) !== undefined ? "pending" : "visitor";
}

/** A snapshot that positively confirms membership (its `joined` step is done). */
function isMemberSnapshot(readiness: Readiness): boolean {
  return readiness.steps.some((s) => s.id === "joined" && s.state === "complete");
}

function isMemberRole(role: Role): boolean {
  return role === "attendee" || role === "organizer";
}

class ReadinessStore {
  readiness = $state<Readiness | undefined>(undefined);
  /**
   * The coordinate `readiness` describes. The store is a module singleton and
   * nothing reset it between events, so navigating A → B painted A's card on B's
   * page — with A's naddr baked into the primary CTA (readiness.ts embeds it at
   * derive time) sitting next to buttons carrying B's. Consumers MUST gate the
   * render on this matching the event they are rendering.
   */
  coordinate = $state<string | undefined>(undefined);
  loading = $state(false);
  private latch = new Map<string, Set<ReadinessStepId>>();
  private token = 0;
  /**
   * Set once a `load()` has produced a network-refined answer for `coordinate`.
   * A `primeLocal()` arriving afterwards (a caller's keystore read landing late)
   * then stands down rather than overwriting the fuller answer with local-only
   * inputs, which would drop `processing` / `matches` back to "checking".
   */
  private refined = false;
  private activeContext: EventContext | undefined;
  private activeSigner: AppSigner | null = null;
  private activeParts: Gathered | undefined;

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
    this.coordinate = undefined;
    this.refined = false;
    this.loading = false;
    this.activeContext = undefined;
    this.activeSigner = null;
    this.activeParts = undefined;
  }

  /**
   * Paint from state that is ALREADY on this device — the caller's completed
   * custody read plus the owner-scoped self-copy cache. Synchronous: no relay,
   * no signer prompt, nothing to await. Callers hand over the keystore read they
   * already performed rather than making the store repeat it.
   *
   * `keys === undefined` means "the read succeeded and this identity holds
   * nothing"; a caller whose read THREW must not call this at all.
   */
  primeLocal(
    ctx: EventContext,
    signer: AppSigner | null,
    keys: EventKeys | undefined,
    opts: { anonymous?: boolean } = {},
  ): void {
    if (!signer && !opts.anonymous) return;
    // A finished load() for this event knows strictly more than we do.
    if (this.refined && this.coordinate === ctx.coordinate) return;
    const coord = ctx.coordinate;
    const fresh = this.coordinate !== coord || this.readiness === undefined;
    const cached = this.seedFromCache(coord, fresh);
    const role = roleFrom(keys, coord);
    if (!this.shouldPaintLocal(cached, role)) return;
    const parts = this.localParts(coord, signer, role);
    this.remember(ctx, signer, parts);
    this.commit(coord, this.derive(ctx, signer, parts));
  }

  /**
   * Re-read the owner-scoped self-copy after background cache hydration or a
   * submission write-through. This only accepts positive intro evidence, so a
   * cache miss cannot regress a network-refined answer.
   */
  refreshFromCache(): void {
    const ctx = this.activeContext;
    const parts = this.activeParts;
    if (!ctx || !parts || this.coordinate !== ctx.coordinate || parts.hasIntro === true) return;
    const self = cachedSelfCopy(ctx.coordinate);
    if (!self || !hasIntroFrom(self)) return;
    parts.hasIntro = true;
    this.commit(ctx.coordinate, this.derive(ctx, this.activeSigner, parts));
  }

  async load(
    ctx: EventContext,
    signer: AppSigner | null,
    opts: { anonymous?: boolean } = {},
  ): Promise<void> {
    // See the module header: with no identity every input below reads "no". The
    // caller must positively confirm there is nobody to wait for (`anonymous`)
    // before a signer-less derivation is allowed to stand as an answer.
    if (!signer && !opts.anonymous) return;
    const tok = ++this.token;
    this.loading = true;
    const coord = ctx.coordinate;
    const fresh = this.coordinate !== coord || this.readiness === undefined;
    this.coordinate = coord;
    this.refined = false;
    // Paint the last derived readiness synchronously before the (many) network
    // fetches, and re-seat the monotonic latch from the persisted set (§2.7).
    const cached = this.seedFromCache(coord, fresh);
    try {
      // ── Local phase: custody + the cached self-copy, no network ────────────
      // Keep "the custody read FAILED" distinguishable from "this identity holds
      // nothing". Both used to collapse into one `.catch(() => undefined)`, so a
      // transient IndexedDB error rendered — and cached — the claim that the
      // viewer is not a member of this event.
      let keys: EventKeys | undefined;
      let custodyRead = false;
      try {
        keys = await loadEventKeys(coord);
        custodyRead = true;
      } catch {
        /* role stays "unknown": the joined step shows "checking", no CTA */
      }
      if (tok !== this.token) return;

      const role: Role = custodyRead ? roleFrom(keys, coord) : "unknown";
      const parts = this.localParts(coord, signer, role);
      this.remember(ctx, signer, parts);
      if (this.shouldPaintLocal(cached, role)) {
        this.commit(coord, this.derive(ctx, signer, parts));
      }
      // An unreadable custody read has nothing left to refine (the network phase
      // is member-only) and must not be written to disk.
      if (!custodyRead) return;

      // ── Network phase: relays + (for remote signers) decrypt prompts ───────
      if (signer?.method === "local") {
        // "Backup secured" is honest for a local key only when a DURABLE,
        // relay-persisted marker exists (recoverable on a fresh device), not the
        // transient dismiss-nag. Remote signers (nip07/nip46) hold the key
        // themselves — deriveReadiness treats that as secured via `signerMethod`.
        // A failed check leaves the step "checking" rather than accusing a
        // backed-up user of not having backed up while they're offline.
        parts.backupAcked = await hasDurableKeyBackup(signer).catch(() => undefined);
      }

      if (isMemberRole(role) && signer) {
        // The self-copy fetch is a relay round-trip AND, for a remote signer, a
        // nip44Decrypt the user has to approve — Amber pops a dialog. Skip it
        // entirely when the cache already proves an intro exists: that step is
        // latched complete, so the fetch could only ever confirm what is already
        // on screen, at the price of a modal on every visit to the event page.
        if (parts.hasIntro !== true) {
          try {
            const bk = await deriveBlindingKey(signer);
            const self = await loadSelfCopy(signer, ctx, bk);
            // An intro can be a recording (media kind "intro") OR a text intro (F1).
            // No relay self-copy is an unknown, not evidence that no intro exists.
            parts.hasIntro = self ? hasIntroFrom(self) : undefined;
          } catch {
            parts.hasIntro = undefined; // couldn't tell — model shows "Checking status"
          }
        }

        if (ctx.config.coordinator) {
          try {
            const pubkey = await signer.getPublicKey();
            const entry = await fetchDirectoryEntry(ctx, pubkey);
            // The authenticated own directory record is a second affirmative
            // source while the self-copy is unavailable. Missing intro fields do
            // not prove absence because coordinator publication can lag submission.
            if (
              entry &&
              hasIntroFrom({ media: entry.media, introText: entry.intro_text })
            ) {
              parts.hasIntro = true;
            }
            // A directory entry with an ai_profile means processing finished; an
            // entry without one (or an intro submitted but not yet in the
            // directory) means it's still in progress.
            parts.processed = entry
              ? !!entry.ai_profile
              : parts.hasIntro
                ? false
                : undefined;
          } catch {
            parts.processed = undefined;
          }
          if (ctx.config.matching === "on") {
            try {
              const list = await fetchMatches(signer, ctx);
              parts.matchesAvailable = !!list;
            } catch {
              parts.matchesAvailable = undefined;
            }
          }
        }
      }

      if (tok !== this.token) return;
      this.commit(coord, this.derive(ctx, signer, parts));
      this.refined = true;
    } finally {
      if (tok === this.token) this.loading = false;
    }
  }

  /**
   * The inputs available without touching the network. `hasIntro` stays
   * `undefined` on a cache MISS — `hasIntroFrom(undefined)` is `false`, which
   * would tell a member who simply hasn't been fetched yet to go record one.
   */
  private localParts(coord: string, signer: AppSigner | null, role: Role): Gathered {
    const self = cachedSelfCopy(coord);
    return {
      role,
      // A local key's real answer is the durable marker, which costs a relay
      // round-trip (network phase). A remote signer never consults this at all,
      // and with no identity `backupNag.done` is true — nothing to nag about.
      backupAcked: signer?.method === "local" ? undefined : backupNag.done,
      hasIntro: self ? hasIntroFrom(self) : undefined,
    };
  }

  private derive(ctx: EventContext, signer: AppSigner | null, parts: Gathered): Readiness {
    const input: ReadinessInput = {
      naddr: ctx.naddr,
      signerMethod: signer?.method,
      matchingEnabled: ctx.config.matching === "on",
      hasCoordinator: !!ctx.config.coordinator,
      online: online.isOnline,
      latched: this.latchFor(ctx.coordinate),
      ...parts,
    };
    return deriveReadiness(input);
  }

  private remember(ctx: EventContext, signer: AppSigner | null, parts: Gathered): void {
    this.activeContext = ctx;
    this.activeSigner = signer;
    this.activeParts = parts;
  }

  /**
   * Whether a freshly derived LOCAL-only readiness should replace what is on
   * screen. A persisted member snapshot carries the network-refined
   * processing/matches steps; re-deriving from local inputs alone drops those
   * back to "Checking status…" for the second or two the network phase takes,
   * which reads as the page losing its place. So keep the cached card whenever
   * local custody agrees with it that the viewer is a member.
   */
  private shouldPaintLocal(cached: Readiness | undefined, role: Role): boolean {
    if (!cached || !isMemberSnapshot(cached)) return true;
    return !isMemberRole(role);
  }

  /** Re-seat the latch from disk; `paint` also shows the cached card. */
  private seedFromCache(coord: string, paint: boolean): Readiness | undefined {
    const cached = cacheGet<PersistedReadiness>(readinessKey(coord))?.data;
    if (!cached || cached.v !== PERSIST_VERSION) return undefined;
    const latch = this.latchFor(coord);
    for (const id of cached.latched) latch.add(id);
    if (paint) {
      this.coordinate = coord;
      this.readiness = cached.readiness;
    }
    return cached.readiness;
  }

  /**
   * Publish a derived readiness, grow the latch, and persist it — but ONLY when
   * it confirms membership.
   *
   * A "you still need to join" verdict is both the cheapest to re-derive (one
   * local keystore read) and the most damaging to get wrong: persisted once, it
   * paints synchronously ahead of any network work and tells an organizer to
   * join their own event before anything can correct it. It is also the verdict
   * every half-established identity produces, and the store cannot always tell
   * one from a genuine visitor — custody reads empty while a logout-locked
   * snapshot is still being decrypted by a remote signer. So: never cache a
   * negative. The persisted latch is the UNION of everything ever completed for
   * this coordinate; it must never shrink, or the next session loses the
   * no-regression guard it exists to provide.
   */
  private commit(coord: string, derived: Readiness): void {
    const latch = this.latchFor(coord);
    for (const s of derived.steps) if (s.state === "complete") latch.add(s.id);
    this.coordinate = coord;
    this.readiness = derived;
    if (!isMemberSnapshot(derived)) return;
    cacheSet(
      readinessKey(coord),
      { v: PERSIST_VERSION, readiness: derived, latched: [...latch] } satisfies PersistedReadiness,
      Math.floor(Date.now() / 1000),
    );
  }
}

export const readinessStore = new ReadinessStore();
