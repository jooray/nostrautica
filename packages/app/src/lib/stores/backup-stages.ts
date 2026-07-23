/**
 * Truthful backup stages (audit UX-O7). Backup wording used to overstate
 * recoverability: copying the nsec to the clipboard immediately claimed "backed
 * up" AND fired the durable-marker publish — but a clipboard copy is not a
 * secured backup, and the marker publish can fail. These are the honest stages,
 * strictly ordered, monotonic (a later signal never regresses an earlier one):
 *
 *  - "none":       nothing done yet.
 *  - "copied":     the secret was copied/exported — visible, not yet secured.
 *  - "saved":      the user explicitly confirmed they stored it somewhere safe.
 *  - "confirmed":  the durable 30078 backup marker was published successfully.
 *
 * The readiness/nag logic keys off "confirmed" (the durable marker), so merely
 * copying no longer silences the nudge.
 */
export type BackupStage = "none" | "copied" | "saved" | "confirmed";

const ORDER: readonly BackupStage[] = ["none", "copied", "saved", "confirmed"];

/** Rank of a stage in the progression (higher = further along). */
export function stageRank(stage: BackupStage): number {
  return ORDER.indexOf(stage);
}

/** Monotonic advance: return whichever of the two stages is further along. */
export function advanceStage(current: BackupStage, to: BackupStage): BackupStage {
  return stageRank(to) > stageRank(current) ? to : current;
}

/** Is the key durably backed up (the only stage that silences the nag)? */
export function isSecured(stage: BackupStage): boolean {
  return stage === "confirmed";
}
