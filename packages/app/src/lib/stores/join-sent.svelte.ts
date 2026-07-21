/**
 * "Join request sent" marker (REMOTE-SIGNER-TEST P2). A join request is a
 * gift-wrapped rumor the app can't cheaply re-query per-attendee, so we remember
 * locally that we sent one — keyed by event coordinate, timestamped. This lets
 * Join show the waiting state (not the pristine form) and EventHome show
 * "Request sent" instead of the Join CTA after a reload. Cleared once approval
 * lands (the ECK grant is the real source of truth) or on an explicit re-send.
 */
const KEY = "nostrautica:join-sent";

type Marker = { at: number };
type Store = Record<string, Marker>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private mode — best effort */
  }
}

/** When we sent a join request for this event, or undefined if we haven't. */
export function joinSentAt(coordinate: string): number | undefined {
  return read()[coordinate]?.at;
}

export function markJoinSent(coordinate: string): void {
  const store = read();
  store[coordinate] = { at: Math.floor(Date.now() / 1000) };
  write(store);
}

export function clearJoinSent(coordinate: string): void {
  const store = read();
  if (coordinate in store) {
    delete store[coordinate];
    write(store);
  }
}

/** Wipe every marker (audit UX-6: logout must not leave "Pending" ghosts
 *  visible to the next person on a shared device). */
export function clearAllJoinSent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode — best effort */
  }
}
