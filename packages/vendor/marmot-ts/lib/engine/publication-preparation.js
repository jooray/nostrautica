/** Internal ownership for preparation rejected before its result is returned. */
const owners = new WeakMap();
export function registerPublicationPreparationOwner(engine, rejected) {
    owners.set(engine, rejected);
}
export function unregisterPublicationPreparationOwner(engine) {
    owners.delete(engine);
}
export function rejectPublicationPreparation(engine, ids) {
    owners.get(engine)?.(ids);
}
