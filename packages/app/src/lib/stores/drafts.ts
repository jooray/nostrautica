/**
 * Lightweight text drafts that survive an automatic refresh (App-2). When a new
 * deploy reloads the tab, an in-progress compose/create field would otherwise be
 * lost even though the reload itself is deferred until the field is "clean" —
 * because the reload eventually happens (or the browser/tab could crash first).
 *
 * Drafts are stored in the persistent app cache under the ACTIVE OWNER's scope,
 * so they inherit two guarantees for free: they survive a reload (IndexedDB
 * mirror rehydrates at boot) and they are wiped on logout (clearOwnerCache), so
 * one person's half-typed message never surfaces for the next on a shared
 * device. Logged out, saves are a silent no-op (the cache has no owner scope) —
 * every drafting surface here requires login anyway.
 *
 * Keep these SMALL: a compose box, a title, a settings note — not media, not
 * large bodies. `id` should identify the surface AND its subject (e.g.
 * `dm:<peer>`, `chat:<naddr>`, `create:title`) so drafts don't collide.
 */
import { cacheGet, cacheSet, cacheDelete } from "$lib/cache/persist.js";

const PREFIX = "draft:";

/** Persist (or, for empty text, clear) the draft for `id`. Owner-scoped. */
export function saveDraft(id: string, text: string): void {
  if (text.trim().length === 0) {
    cacheDelete(PREFIX + id);
    return;
  }
  cacheSet(PREFIX + id, text);
}

/** Read back a persisted draft for `id`, or undefined if none. */
export function loadDraft(id: string): string | undefined {
  return cacheGet<string>(PREFIX + id)?.data;
}

/** Drop the draft for `id` (call after a successful send/save). */
export function clearDraft(id: string): void {
  cacheDelete(PREFIX + id);
}

/**
 * Multi-field form draft (audit U9): a small bag of TEXT fields (post title +
 * body, authored profile fields, …) persisted as one owner-scoped JSON entry.
 * Same guarantees as `saveDraft`: owner-scoped, survives reload, wiped on logout.
 * Keep it to short text — never raw secrets or large media (that contract is why
 * the generic draft store exists). A form with no non-empty text field clears.
 */
export function saveFormDraft(id: string, form: Record<string, string>): void {
  const hasText = Object.values(form).some((v) => typeof v === "string" && v.trim().length > 0);
  if (!hasText) {
    cacheDelete(PREFIX + id);
    return;
  }
  cacheSet(PREFIX + id, JSON.stringify(form));
}

/** Read back a persisted form draft for `id`, or undefined if none/corrupt. */
export function loadFormDraft<T>(id: string): T | undefined {
  const raw = cacheGet<string>(PREFIX + id)?.data;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}
