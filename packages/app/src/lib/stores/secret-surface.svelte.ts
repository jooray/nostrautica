/**
 * Secret-surface guard (§13.3, Option A). A shared, refcounted switch every
 * secret-bearing surface enters while it is on screen — an admin invite
 * nsec/QR, a key backup/reveal, chat device handoff/management. While any
 * surface is active, the organizer-controlled event theme is suppressed
 * (`theme-injector`), so no CSS from a 31609 stylesheet is ever live in a
 * document that also holds a secret (CSS can exfiltrate DOM text via attribute
 * selectors + background/font requests).
 *
 * `enterSecretSurface()` removes the stylesheet SYNCHRONOUSLY (via the injector)
 * so there is no one-frame exposure, and returns an idempotent exit fn. The
 * reactive `active` flag lets the layout's theme effect re-sync when the last
 * surface closes. Login/Settings/DM already carry no event naddr, so they were
 * never themed; this closes the surfaces that DO live on themed event routes
 * (Admin invites, chat device management) and any future one via the same guard.
 */
import { suppressEventTheme, releaseEventTheme } from "$lib/events/theme-injector.js";

let count = $state(0);

export const secretSurface = {
  /** True while at least one secret surface is mounted. */
  get active(): boolean {
    return count > 0;
  },
};

/**
 * Enter a secret surface: suppress event theming now and return an idempotent
 * releaser. Call from `onMount` (its return becomes the unmount cleanup):
 *
 *   onMount(() => enterSecretSurface());
 */
export function enterSecretSurface(): () => void {
  count++;
  // Synchronous imperative removal — do not wait for the reactive layout effect,
  // so the secret never paints with an event stylesheet live.
  suppressEventTheme();
  let exited = false;
  return () => {
    if (exited) return;
    exited = true;
    count = Math.max(0, count - 1);
    if (count === 0) releaseEventTheme();
  };
}

/** Test-only: reset the refcount + release suppression between cases. */
export function __resetSecretSurfaceForTests(): void {
  count = 0;
  releaseEventTheme();
}
