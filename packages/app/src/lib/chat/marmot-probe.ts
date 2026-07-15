/**
 * PACKAGING PROBE (Phase 2 gate). Proves the vendored `@internet-privacy/marmot-ts`
 * (kind-30443 wire format) resolves AND survives a real SvelteKit/Vite production
 * build in this environment — the one Phase-0 spike condition left unverified.
 *
 * It is intentionally trivial (imports the client + the wire-kind constant and the
 * deep-imported `proposeRemoveUser` upstream workaround) and lives in its own lazy
 * chunk. Once the real `chat/client.ts` lands this file can be deleted; keeping the
 * import surface here documents the three integration points that must bundle.
 */
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "@internet-privacy/marmot-ts/core";
// `proposeRemoveUser` is not in marmot-ts's export map (UPSTREAM U7) — deep-import
// it through the vendored package's `./lib/*` wildcard export.
import { proposeRemoveUser } from "@internet-privacy/marmot-ts/lib/client/group/proposals/remove-member.js";

/** The Marmot v2 KeyPackage kind we publish (30443, not legacy 443). */
export const MARMOT_KEY_PACKAGE_KIND = ADDRESSABLE_KEY_PACKAGE_KIND;

export function marmotProbe(): { client: typeof MarmotClient; remove: typeof proposeRemoveUser } {
  return { client: MarmotClient, remove: proposeRemoveUser };
}
