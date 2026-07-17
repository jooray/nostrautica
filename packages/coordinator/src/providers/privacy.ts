/**
 * Per-role model-privacy verification (spec §16.2/§16.4, audit H6). Each model
 * role (summary/match/embed/translate) may override the provider-level privacy
 * default with `models.<role>.require_private`. At startup the daemon checks each
 * role's model against the live Venice model catalogue:
 *
 *   - require_private=true  + model NOT private  → hard error (fail closed).
 *   - require_private=false + model NOT private  → warning (operator-accepted, e.g.
 *     the reference deployment's non-private match tier — spec §16.4).
 *   - model missing from the catalogue           → warning (ids are volatile,
 *     spec §15; embedding models may be listed under another type).
 *
 * Extracted from main.ts so it can be unit-tested with a mock provider without
 * booting the daemon.
 */
import type { CoordinatorConfig, ModelRole } from "../config.js";
import { roleRequiresPrivate } from "../config.js";
import type { LlmProvider } from "./types.js";

const ROLES: ModelRole[] = ["summary", "match", "embed", "translate"];

export async function verifyModelPrivacy(
  llm: LlmProvider,
  config: CoordinatorConfig,
  logger: { warn: (m: string) => void } = console,
): Promise<void> {
  let all;
  try {
    all = await llm.models();
  } catch (err) {
    logger.warn(`[coordinator] could not verify model privacy (GET /models failed): ${err}`);
    return;
  }
  const byId = new Map(all.map((m) => [m.id, m]));
  for (const role of ROLES) {
    const ref = config.models[role];
    if (ref.provider !== "venice") continue;
    const info = byId.get(ref.model);
    if (!info) {
      // Embedding models are catalogued on a separate endpoint
      // (`GET /models?type=embedding`) that `models()` (text/image inference)
      // doesn't return, so a valid embed model is expectedly absent here — not a
      // problem. Only warn for the inference roles, whose models SHOULD be listed.
      if (role !== "embed") {
        logger.warn(
          `[coordinator] models.${role} "${ref.model}" not found in GET /models — cannot verify privacy tier`,
        );
      }
      continue;
    }
    const wantPrivate = roleRequiresPrivate(config, role);
    if (wantPrivate && !info.private) {
      throw new Error(
        `models.${role} "${ref.model}" is not a Venice private/TEE-tier model. ` +
          `Pick a private model, or explicitly accept the trade-off with models.${role}.require_private = false`,
      );
    }
    if (!wantPrivate && !info.private) {
      logger.warn(
        `[coordinator] models.${role} "${ref.model}" is NOT private-tier (require_private=false accepted): prompts leave the TEE boundary`,
      );
    }
  }
}
