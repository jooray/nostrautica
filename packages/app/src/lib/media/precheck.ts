/**
 * Client-side media precheck (audit U13 / R17). A selected file used to be
 * uploaded unconditionally — the user could wait through a full encrypt + Blossom
 * upload for a clip that was predictably over the event's limit, only to have the
 * coordinator reject it. This compares the KNOWN file size and (when metadata
 * loaded cheaply) duration against the event's configured limits and fails early
 * with a clear, actionable message. The server-side checks stay authoritative;
 * this only spares the user an upload that was always going to be rejected.
 */
import { MAX_MEDIA_DOWNLOAD_BYTES } from "$lib/blossom/client.js";

/**
 * Absolute upper bound on an upload (bytes). R17: this MUST equal the playback
 * ceiling — `MAX_MEDIA_DOWNLOAD_BYTES` (250 MiB) in blossom/client.ts, the same
 * limit `playback.ts` refuses a descriptor over. The precheck previously accepted
 * up to 1 GiB, so a 300 MiB clip could encrypt + upload "successfully" and then
 * be unplayable in the very same app. Sharing ONE constant guarantees anything
 * accepted for upload is playable. (The coordinator's per-submission AGGREGATE
 * cap across all media is higher — 500 MiB over up to 4 descriptors — so this
 * per-file playback bound is the tightest honest limit; see handoff.)
 */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_DOWNLOAD_BYTES;

export interface MediaLimitViolation {
  kind: "duration" | "size";
  /** The permitted value (seconds for duration, bytes for size). */
  limit: number;
  /** The selected file's actual value (seconds / bytes). */
  actual: number;
}

/**
 * Return the first limit the selected file violates, or null when it is
 * acceptable. `durationSec === 0` means metadata didn't load (unknown) — we don't
 * reject on an unknown duration, deferring to the authoritative server check.
 * `maxSec === 0` means the organizer set no duration cap (unlimited).
 */
export function checkMediaLimits(opts: {
  sizeBytes: number;
  durationSec: number;
  maxSec: number;
}): MediaLimitViolation | null {
  if (opts.maxSec > 0 && opts.durationSec > 0 && opts.durationSec > opts.maxSec) {
    return { kind: "duration", limit: opts.maxSec, actual: opts.durationSec };
  }
  if (opts.sizeBytes > MAX_UPLOAD_BYTES) {
    return { kind: "size", limit: MAX_UPLOAD_BYTES, actual: opts.sizeBytes };
  }
  return null;
}
