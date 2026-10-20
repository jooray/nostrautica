/**
 * Serialize read-modify-write mutations of one replaceable document.
 *
 * `publishMonotonic` orders the TIMESTAMPS of two same-address publishes, but it
 * does not merge their CONTENT: a whole-document writer (per-event settings, the
 * mute list, the reuse library) that loads, edits one entry and republishes is
 * only correct if nothing else edits the same document between its load and its
 * publish. Two quick taps in one tab did exactly that — both loads saw the same
 * baseline, and the later publish silently dropped the earlier change (audit
 * DS41-007). Running the whole load → edit → publish under one lock per
 * document makes the second mutation load what the first one wrote.
 *
 * Web Locks when available, so two tabs of the same profile serialize too;
 * otherwise an in-process promise chain (Node/tests, very old engines). This
 * does nothing for two DEVICES — that needs a merge on the wire, not a lock.
 */

interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

let lockMgr: LockManagerLike | null | undefined; // undefined = use navigator.locks

/** Test seam: inject a lock manager, or pass null to force the in-process chain. */
export function __setMutationLocks(l: LockManagerLike | null | undefined): void {
  lockMgr = l;
}

function locks(): LockManagerLike | null {
  if (lockMgr !== undefined) return lockMgr;
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return (navigator as unknown as { locks: LockManagerLike }).locks;
  }
  return null;
}

const tails = new Map<string, Promise<void>>();

async function inProcess<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mine = prev.then(() => gate);
  tails.set(name, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(name) === mine) tails.delete(name);
  }
}

/**
 * Run `fn` holding the exclusive mutation lock `name`. Use a name that includes
 * the owner and the document address, e.g. `rmw:<pubkey>:30078:<d>`.
 */
export async function withMutationLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const mgr = locks();
  if (mgr) return (await mgr.request(name, fn)) as T;
  return inProcess(name, fn);
}
