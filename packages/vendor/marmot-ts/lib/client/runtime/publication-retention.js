/** Internal per-owner bridge; no option or public barrel export. */
const sessions = new WeakMap();
const runtimes = new WeakMap();
export function registerPublicationRetention(session, confirmed) {
    sessions.set(session, confirmed);
}
export function linkPublicationRetention(runtime, session) {
    runtimes.set(runtime, session);
}
export function confirmPublicationRetention(runtime, eventId) {
    const owner = runtimes.get(runtime);
    if (owner)
        sessions.get(owner)?.(eventId);
}
export function unregisterPublicationRetention(session) {
    sessions.delete(session);
}
