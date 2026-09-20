/**
 * IndexedDB cannot structured-clone a Svelte $state proxy, including one nested
 * inside an otherwise plain object. Snapshot at the shared persistence boundary
 * so callers cannot accidentally save only to the in-memory mirror (DM reads
 * did exactly that). It also detaches the stored value from later UI mutations.
 */
export function cacheSnapshot<T>(value: T): T {
  return $state.snapshot(value) as T;
}
