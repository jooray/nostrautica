/**
 * Centralized copy-to-clipboard (audit U15). Several call sites used
 * `navigator.clipboard.writeText(...)` directly and either swallowed the
 * rejection or left it unhandled, with no fallback — so in embedded browsers,
 * Safari, restrictive permissions policies, or insecure (http) dev contexts the
 * copy silently failed and the UI still flashed "Copied". That is especially bad
 * for SECRETS (invite links carry single-use nsecs): a user who cannot copy must
 * still be able to see and select the value.
 *
 * `copyText` tries the async Clipboard API first, then a synchronous
 * `execCommand("copy")` fallback (works in more embedded/older engines), and
 * returns a truthful boolean so the caller can show success, failure, or a
 * deliberate reveal/select affordance. It never throws.
 */

export type CopyResult = "copied" | "failed";

/**
 * Copy `text` to the clipboard. Returns "copied" on success, "failed" otherwise.
 * Never throws — the caller decides how to surface failure (and, for secrets,
 * should reveal a selectable copy of the value).
 */
export async function copyText(text: string): Promise<CopyResult> {
  // Preferred path: the async Clipboard API (secure contexts, granted policy).
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    /* fall through to the execCommand fallback */
  }
  // Fallback: a hidden, selected textarea + execCommand("copy"). Deprecated but
  // still the only working path in a number of embedded webviews and on http.
  if (execCommandCopy(text)) return "copied";
  return "failed";
}

/** Synchronous copy via a throwaway selected textarea. False when unavailable. */
function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  // Keep it off-screen and unfocusable-by-scroll, but still selectable.
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    // execCommand is not typed on some lib configs; guard defensively.
    const exec = (document as unknown as { execCommand?: (c: string) => boolean }).execCommand;
    return typeof exec === "function" ? exec.call(document, "copy") : false;
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}
