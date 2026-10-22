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
import type { CoordinatorConfig, ModelRole, OptionalModelRole } from "../config.js";
import { roleRequiresPrivate } from "../config.js";
import type { LlmProvider, ModelInfo, RoleRoute, RoleRoutes } from "./types.js";

const ROLES: ModelRole[] = ["summary", "match", "embed", "translate"];
/** Roles that may be absent. Resolved like the rest when configured. */
const OPTIONAL_ROLES: OptionalModelRole[] = ["match_score"];

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
  for (const role of OPTIONAL_ROLES) {
    const ref = config.models[role];
    if (ref) referenced.add(ref.provider);
  }
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
  for (const role of [...ROLES, ...OPTIONAL_ROLES]) {
    const ref = config.models[role];
    // An optional role that isn't configured is simply absent from `routes`; the
    // pipeline checks for it rather than being handed a placeholder.
    if (!ref) continue;
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
      // Booted under the escape hatch: say so in the announcement too, rather than
      // publishing the operator's intent as a checked tier (audit R-52).
      privacy = requirePrivate ? "unverified" : "non-private";
      logger.warn(
        `[coordinator] models.${role} "${ref.model}" privacy UNVERIFIED (${ref.provider} catalogue unfetchable)`,
      );
    } else {
      const info = catalogue.get(ref.model);
      if (!info) {
        // Every role's model is expected in the catalogue: VeniceLlm.models() reads
        // the embedding and decision pages as well as the text one. A miss is a
        // typo, a model the provider retired, or a page that failed to load.
        logger.warn(
          `[coordinator] models.${role} "${ref.model}" not found in ${ref.provider} catalogue — cannot verify privacy tier`,
        );
        // The decision model rides on a SEPARATE catalogue page, and a failure to
        // fetch that page is indistinguishable from "no decision models" by the
        // time it reaches here (audit DS41-045). Publishing `match_score: "private"`
        // for it would be a tier nobody checked, so it fails closed exactly like an
        // unfetchable catalogue: an unverifiable private-required decision role
        // needs the explicit escape hatch.
        if (role === "match_score" && requirePrivate && !deps.allowUnverified) {
          throw new Error(
            `could not verify privacy for models.match_score "${ref.model}" — not in the ${ref.provider} ` +
              `catalogue (its decision page may have failed to load) and the role requires a private-tier model. ` +
              `Check the model id, or explicitly boot unverified with security.allow_unverified_model_privacy = true`,
          );
        }
        // Every other role used to publish "private" here on the operator's word
        // alone, and embed always landed here (audit R-52). Announce what is
        // actually known. Not fatal, unlike match_score above: that page is new
        // and optional, while an embed or summary role that boots today must not
        // start refusing to boot because one catalogue page had a bad minute.
        privacy = requirePrivate ? "unverified" : "non-private";
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
    // A decision role is useless on a provider without a decision endpoint, and
    // the failure would otherwise surface as a poisoned scoring job per batch
    // rather than as a refusal to boot.
    if (role === "match_score" && typeof instance.decide !== "function") {
      throw new Error(
        `models.match_score routes to provider "${ref.provider}", which has no decision endpoint. ` +
          `Point it at a provider that implements one (Venice), or remove models.match_score to ` +
          `score with models.match alone.`,
      );
    }
    routes[role] = { llm: instance, model: ref.model, provider: ref.provider, requirePrivate, privacy };
  }
  return routes;
}

/**
 * The STT tier for the disclosure map. Optional, and there is no default that
 * claims anything.
 *
 * Every LLM role's tier in this map is VERIFIED — resolved against the provider's
 * own catalogue above, and startup fails closed when a `require_private` role
 * cannot be confirmed. `stt` was a hardcoded `"private"` string sitting in the
 * same object, indistinguishable to any reader from the four that were checked
 * (2026-09-04 audit). It is a public claim about where an attendee's recorded
 * voice goes, made in the 31611 announcement that organizers pick a coordinator
 * on, and nothing anywhere established it.
 *
 * It cannot be verified the way the others are: Venice's `GET /models` returns the
 * LLM catalogue, and the STT model (`openai/whisper-large-v3`) is not in it — the
 * same reason the `embed` role is exempted from the not-found warning above. So
 * the honest options were "verify it" and "say it is unverified", and this is how
 * a caller that HAS verified it supplies the answer.
 */
export interface SttDisclosure {
  /** STT provider id, e.g. "venice-stt" (for the operator's own diagnostics). */
  provider: string;
  model: string;
  /** The tier, when the caller actually established it. Omitted = unverified. */
  privacy?: RoleRoute["privacy"];
}

/**
 * The per-role privacy map for the 31611 announcement, from the RESOLVED routes.
 *
 * `stt` reads `"unverified"` unless a caller passes a tier it has established.
 * That is a deliberate downgrade from the previous unconditional `"private"`:
 * overstating a privacy guarantee is the failure that matters here, and the app's
 * coordinator picker already renders any role whose value is not `"private"`, so
 * the claim becomes visible to organizers instead of quietly true-by-assertion.
 */
export function disclosureFromRoutes(routes: RoleRoutes, stt?: SttDisclosure): Record<string, string> {
  const privacy: Record<string, string> = { stt: stt?.privacy ?? "unverified" };
  for (const role of ROLES) privacy[role] = routes[role].privacy;
  // Only announced when configured: a role that does not exist has no tier, and
  // publishing one for it would be a claim about a data flow that never happens.
  for (const role of OPTIONAL_ROLES) {
    const r = routes[role];
    if (r) privacy[role] = r.privacy;
  }
  return privacy;
}
