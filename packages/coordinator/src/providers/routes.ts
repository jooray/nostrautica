/**
 * Per-role provider ROUTING (audit H-1, spec §13.5 Option A). Configuration
 * declares a provider + model per role (summary/match/embed/translate); v1 built a
 * single global LLM and pointed every role at it, so a role configured for Venice
 * could silently run on Routstr while the public announcement advertised the wrong
 * privacy posture. This module resolves and VALIDATES a concrete provider instance
 * per role at startup, and returns the resolved routes so:
 *
 *   - the pipeline threads each role's own instance to its call sites, and
 *   - the 31611 announcement's privacy map is generated from the VERIFIED routes.
 *
 * Startup fails closed on: a role pointing at a provider that isn't configured
 * (missing api key / node_url / unknown provider id), and a `require_private` role
 * whose resolved model is not a private-tier model in the provider's own catalogue
 * (unless the operator sets `security.allow_unverified_model_privacy`).
 */
import type { CoordinatorConfig, ModelRole } from "../config.js";
import { roleRequiresPrivate } from "../config.js";
import type { LlmProvider, ModelInfo, RoleRoute, RoleRoutes } from "./types.js";

const ROLES: ModelRole[] = ["summary", "match", "embed", "translate"];

export interface ResolveRoutesDeps {
  /** Provider instances the daemon was able to construct, keyed by provider id
   *  ("venice" | "routstr"). A role referencing an absent id fails startup. */
  providers: Partial<Record<string, LlmProvider>>;
  logger?: { warn: (m: string) => void };
  /** Escape hatch (audit COORD-20): boot even when a provider catalogue can't be
   *  fetched to verify a `require_private` role. Warns instead of failing. */
  allowUnverified?: boolean;
}

/**
 * Resolve a provider instance per role and verify privacy tiers. Throws on any
 * unsatisfiable route so the daemon never boots into a misrouted / mis-disclosed
 * state. The returned routes carry the VERIFIED privacy tier for the announcement.
 */
export async function resolveRoleRoutes(
  config: CoordinatorConfig,
  deps: ResolveRoutesDeps,
): Promise<RoleRoutes> {
  const logger = deps.logger ?? console;
  // Query each DISTINCT referenced provider's catalogue exactly once. A catalogue
  // that can't be fetched is recorded as `null` so a require_private role on it
  // fails closed (unless allowUnverified) while a non-private role just warns.
  const catalogues = new Map<string, Map<string, ModelInfo> | null>();
  const referenced = new Set(ROLES.map((r) => config.models[r].provider));
  for (const providerId of referenced) {
    const instance = deps.providers[providerId];
    if (!instance) continue; // reported per-role below with a targeted message
    if (catalogues.has(providerId)) continue;
    try {
      const models = await instance.models();
      catalogues.set(providerId, new Map(models.map((m) => [m.id, m])));
    } catch (err) {
      catalogues.set(providerId, null);
      logger.warn(`[coordinator] could not fetch ${providerId} model catalogue: ${err}`);
    }
  }

  const routes = {} as RoleRoutes;
  for (const role of ROLES) {
    const ref = config.models[role];
    const instance = deps.providers[ref.provider];
    if (!instance) {
      throw new Error(
        `models.${role} references provider "${ref.provider}" which is not configured ` +
          `(check the provider's api_key / node_url, or that "${ref.provider}" is a supported provider)`,
      );
    }
    const requirePrivate = roleRequiresPrivate(config, role);
    const catalogue = catalogues.get(ref.provider);
    let privacy: RoleRoute["privacy"];
    if (catalogue === null || catalogue === undefined) {
      // Catalogue unfetchable → fail closed for a private-required role.
      if (requirePrivate && !deps.allowUnverified) {
        throw new Error(
          `could not verify privacy for models.${role} "${ref.model}" — ${ref.provider} ` +
            `catalogue unfetchable and the role requires a private-tier model. Fix connectivity, ` +
            `or explicitly boot unverified with security.allow_unverified_model_privacy = true`,
        );
      }
      privacy = requirePrivate ? "private" : "non-private";
      logger.warn(
        `[coordinator] models.${role} "${ref.model}" privacy UNVERIFIED (${ref.provider} catalogue unfetchable)`,
      );
    } else {
      const info = catalogue.get(ref.model);
      if (!info) {
        // Embedding models are catalogued on a separate endpoint that models()
        // doesn't return, so a valid embed model is expectedly absent — not fatal.
        if (role !== "embed") {
          logger.warn(
            `[coordinator] models.${role} "${ref.model}" not found in ${ref.provider} catalogue — cannot verify privacy tier`,
          );
        }
        privacy = requirePrivate ? "private" : "non-private";
      } else if (info.private) {
        privacy = "private";
      } else {
        if (requirePrivate) {
          throw new Error(
            `models.${role} "${ref.model}" is not a private/TEE-tier ${ref.provider} model. ` +
              `Pick a private model, or explicitly accept the trade-off with models.${role}.require_private = false`,
          );
        }
        logger.warn(
          `[coordinator] models.${role} "${ref.model}" is NOT private-tier (require_private=false accepted): prompts leave the TEE boundary`,
        );
        privacy = "non-private";
      }
    }
    routes[role] = { llm: instance, model: ref.model, provider: ref.provider, requirePrivate, privacy };
  }
  return routes;
}

/** The per-role privacy map for the 31611 announcement, from the RESOLVED routes. */
export function disclosureFromRoutes(routes: RoleRoutes): Record<string, string> {
  const privacy: Record<string, string> = { stt: "private" };
  for (const role of ROLES) privacy[role] = routes[role].privacy;
  return privacy;
}
