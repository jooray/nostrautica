/**
 * Human-readable byte sizes, shared by the offline-pack storage line and the
 * media player's download progress. Lives here rather than in offline-pack so a
 * component that only needs the formatter doesn't drag that module's whole
 * fetcher graph into its bundle chunk.
 */

/**
 * Decimal units (1 KB = 1000 B), matching what macOS/Android surface to the same
 * user elsewhere — this used to divide by 1024 while labelling the result
 * "KB/MB/GB", understating every figure by 2.4% per unit step (a 7% error by GB).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const v = bytes / 1000 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
