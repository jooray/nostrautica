/** Internal completion ownership, deliberately absent from public barrels. */
const owners = new WeakMap();
export function registerSettledRetentionOwner(engine, complete) {
    owners.set(engine, complete);
}
export function unregisterSettledRetentionOwner(engine) {
    owners.delete(engine);
}
export async function completeSettledRetentionOwner(engine) {
    await owners.get(engine)?.();
}
