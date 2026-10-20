/**
 * Re-seed a form field from fresh data without clobbering an unsaved edit.
 *
 * A settings page seeds its inputs from the loaded config, then replaces that
 * config whenever anything on the page is saved (or a fresher copy loads). An
 * effect that simply re-assigned every field from the config on each
 * replacement reset what the user had typed in OTHER cards: change the talks
 * mode, save the retention card, and the talks dropdown snapped back (audit
 * SB-17).
 *
 * The rule: the field follows the data only while it still shows what was last
 * seeded into it (the user has not touched it); once edited, it keeps the
 * user's value until they save or revert it. Compare with `equal` for values
 * that are not primitives.
 */
export function reseed<T>(
  current: T,
  lastSeed: T | undefined,
  next: T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  if (lastSeed === undefined || equal(current, lastSeed)) return next;
  return current;
}
