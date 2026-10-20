/**
 * Run a read → decide → write sequence exclusively per `name`, across every tab
 * of this browser profile (Web Locks), falling back to an in-process async mutex
 * where `navigator.locks` does not exist.
 *
 * For one-time minting of per-account secrets that live in SHARED storage (the
 * blinding seed, the chat device key): two tabs that each read "none yet" and
 * each mint produce two different secrets, and whichever loses the write keeps
 * using a key nothing else knows. The holder re-reads inside the lock, so the
 * second tab sees what the first one wrote.
 *
 * Same mechanism as `nostr/monotonic.ts`'s per-address lock; kept separate so a
 * caller does not pull the relay stack in just to serialize a storage read.
 */

interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

let injected: LockManagerLike | null | undefined; // undefined = navigator.locks

/** Tests only: inject a lock manager, or null to force the in-process fallback. */
export function __setExclusiveLocks(l: LockManagerLike | null | undefined): void {
  injected = l;
}

function manager(): LockManagerLike | null {
  if (injected !== undefined) return injected;
  if (typeof navigator !== "undefined" && "locks" in navigator && navigator.locks) {
    return navigator.locks as unknown as LockManagerLike;
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

export async function withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const mgr = manager();
  if (mgr) return (await mgr.request(name, fn)) as T;
  return inProcess(name, fn);
}
