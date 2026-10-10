/**
 * Retire MLS groups this library generation can no longer run (the 0x8009 flag
 * day: MARMOT-GROUP-CHAT.md, "Library: vendored marmot-ts and the 0x8009 flag day").
 *
 * marmot-ts 0.6.0 built groups under the legacy account-identity proof (component
 * 0xF2F1). The current library — and White Noise / MDK — only run groups whose
 * GroupContext carries the 0x8009 profile; a legacy group still loads, but every
 * inbound event for it is refused, so it is a room nobody can talk in. There is no
 * in-place upgrade (the proof lives in every member's leaf, and the members'
 * clients re-key on their own schedule), and the owner decided against migrating
 * history: old rooms are discarded, a fresh one is created per chat-enabled event,
 * and members are re-added as their devices publish current KeyPackages.
 *
 * This runs once per daemon start, BEFORE anything loads or touches a group, and is
 * idempotent: once every stored group is current it finds nothing to do. It never
 * publishes — a retired group gets no Remove or self-remove traffic (its members
 * cannot process it anyway); it simply stops existing here. The replacement group
 * is created by the normal `ensureChat` path, which also republishes the roster
 * with the new nostr_group_id (`MarmotAdmin.ensureGroup`) and re-adds every
 * attested device through `backfillApproved` / the 30443 watcher.
 */
import type { Store } from "../store/db.js";
import type { GroupProfileStatus } from "./mls.js";

export interface RetirableMls {
  storedGroupIds(): Promise<string[]>;
  groupProfile(mlsGroupIdHex: string): Promise<GroupProfileStatus>;
  retireGroup(mlsGroupIdHex: string): Promise<void>;
}

export interface RetireResult {
  /** Event coordinates whose group row was dropped (a fresh group follows). */
  coordinates: string[];
  /** Every MLS group id whose local state was purged (rooms + orphans). */
  groups: string[];
}

export async function retireStaleGroups(deps: {
  store: Store;
  mls: RetirableMls;
  log?: (msg: string) => void;
}): Promise<RetireResult> {
  const { store, mls } = deps;
  const log = deps.log ?? (() => {});
  const result: RetireResult = { coordinates: [], groups: [] };

  // Event rooms first: a row whose group is not current is dropped together with
  // its state, so ensureGroup recreates it. A row with NO state at all
  // ("unreadable" covers missing) is equally dead — a group the coordinator cannot
  // load is one it cannot administer.
  const referenced = new Set<string>();
  for (const row of store.allMarmotGroups()) {
    referenced.add(row.mls_group_id.toLowerCase());
    const status = await mls.groupProfile(row.mls_group_id);
    if (status === "current") continue;
    await mls.retireGroup(row.mls_group_id);
    store.deleteMarmotGroup(row.coordinate);
    result.coordinates.push(row.coordinate);
    result.groups.push(row.mls_group_id);
    log(
      `[chat] retired the ${status} MLS group of ${row.coordinate} (${row.mls_group_id.slice(0, 12)}…): ` +
        `it predates the 0x8009 identity-proof profile — a fresh group will be created and members re-added`,
    );
  }

  // Then anything else we hold state for — a White Noise link-confirmation group
  // whose teardown never ran, for one. Only non-current ones: a current orphan is
  // most likely a confirmation group with its link still open, and its own expiry
  // sweep owns it.
  for (const id of await mls.storedGroupIds()) {
    if (referenced.has(id.toLowerCase())) continue;
    const status = await mls.groupProfile(id);
    if (status === "current") continue;
    await mls.retireGroup(id);
    result.groups.push(id);
    log(`[chat] purged ${status} orphan MLS group state ${id.slice(0, 12)}…`);
  }

  return result;
}
