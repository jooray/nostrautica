/**
 * Coordinator configuration (spec §9.5). Loaded from coordinator.toml + env
 * secrets. Installation is protocol-level (21603 grant), so there is no per-event
 * server config here — only the daemon's identity, providers, and matching knobs.
 */
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { decode } from "nostr-tools/nip19";
import { decrypt as nip49Decrypt } from "nostr-tools/nip49";
import {
  hexToBytes,
  type CoordinatorAnnounce,
  type CoordinatorBilling,
} from "@nostrautica/protocol";

// A model role may opt out of the provider's private-tier restriction (spec §16.2):
// the matching-benchmark winner (deepseek-v4-flash) is not a Venice private model,
// so `models.match.require_private = false` relaxes the filter for THAT role only.
// Summary/STT keep the provider default (private). Omitting the field = provider default.
const modelRefSchema = z.object({
  provider: z.string(),
  model: z.string(),
  require_private: z.boolean().optional(),
});

export const configSchema = z.object({
  identity: z
    .object({
      ncryptsec_file: z.string().optional(),
    })
    .default({}),
  relays: z.object({ default: z.array(z.string()).min(1) }),
  providers: z
    .object({
      venice: z
        .object({
          api_key_env: z.string().default("VENICE_API_KEY"),
          require_private: z.boolean().default(true),
          base_url: z.string().optional(),
        })
        .optional(),
      routstr: z
        .object({
          node_url: z.string().optional(),
          discover: z.boolean().default(false),
          mint: z.string().optional(),
          wallet_db: z.string().optional(),
        })
        .optional(),
    })
    .default({}),
  stt: z
    .object({
      provider: z.enum(["venice-stt", "local-whisper"]).default("venice-stt"),
      model: z.string().default("openai/whisper-large-v3"),
    })
    .default({}),
  models: z.object({
    summary: modelRefSchema,
    match: modelRefSchema,
    embed: modelRefSchema,
    // Translates user-authored profile fields into the event language (spec §7.1).
    // Default gemini-3-flash-preview (a Venice model id, see benchmarks/matching);
    // it sees user content, so it inherits the provider's require_private by default.
    translate: modelRefSchema.default({
      provider: "venice",
      model: "gemini-3-flash-preview",
    }),
  }),
  matching: z
    .object({
      prefilter_threshold: z.number().default(50),
      prefilter_top_m: z.number().default(30),
      prefilter_random: z.number().default(10),
      top_k: z.number().default(20),
      /** Candidates per batched match-scoring call (benchmark winner: K=10). */
      batch_size: z.number().int().min(1).default(10),
    })
    .default({}),
  // Public discovery announcement (kind 31611, docs/COORDINATOR-DISCOVERY-PLAN.md).
  // Published on boot so organizers can pick this coordinator instead of pasting
  // its npub. `announce=false` opts out (stays private/paste-only).
  coordinator: z
    .object({
      announce: z.boolean().default(true),
      name: z.string().default("Nostrautica coordinator"),
      about: z.string().optional(),
      picture: z.string().optional(),
      operator: z.string().optional(),
      terms_url: z.string().optional(),
    })
    .default({}),
  // Billing policy (Part 3). Payment is NOT handled here — this only shapes the
  // announce + the `billing` signal in the 21606 status. Default: free.
  pricing: z
    .object({
      model: z
        .enum(["free", "per_user", "per_event", "negotiated", "external"])
        .default("free"),
      free_up_to_users: z.number().int().nonnegative().optional(),
      summary: z.string().optional(),
      checkout_url: z.string().optional(),
      currency: z.string().optional(),
      // Organizer npubs/hex pubkeys that are ALWAYS free (community events).
      // Private — evaluated at billing time, never put in the public announce.
      free_organizers: z.array(z.string()).default([]),
    })
    .default({}),
});

export type CoordinatorConfig = z.infer<typeof configSchema>;

export function loadConfig(path: string): CoordinatorConfig {
  const raw = parseToml(readFileSync(path, "utf8"));
  return configSchema.parse(raw);
}

/**
 * Resolve the coordinator's secret key: env NOSTRAUTICA_COORDINATOR_NSEC (nsec or
 * hex), else the ncryptsec_file decrypted with NOSTRAUTICA_COORDINATOR_PASSPHRASE.
 */
export function resolveIdentity(config: CoordinatorConfig): Uint8Array {
  const envKey = process.env.NOSTRAUTICA_COORDINATOR_NSEC;
  if (envKey) {
    if (envKey.startsWith("nsec1")) {
      const decoded = decode(envKey);
      if (decoded.type !== "nsec") throw new Error("invalid nsec");
      return decoded.data;
    }
    if (/^[0-9a-f]{64}$/i.test(envKey)) return hexToBytes(envKey);
    throw new Error("NOSTRAUTICA_COORDINATOR_NSEC must be nsec or 64-char hex");
  }
  if (config.identity.ncryptsec_file) {
    const passphrase = process.env.NOSTRAUTICA_COORDINATOR_PASSPHRASE;
    if (!passphrase) throw new Error("NOSTRAUTICA_COORDINATOR_PASSPHRASE required to decrypt key");
    const ncryptsec = readFileSync(config.identity.ncryptsec_file, "utf8").trim();
    return nip49Decrypt(ncryptsec, passphrase);
  }
  throw new Error("No coordinator identity: set NOSTRAUTICA_COORDINATOR_NSEC or identity.ncryptsec_file");
}

/** Read a provider API key from the configured env var. */
export function veniceApiKey(config: CoordinatorConfig): string | undefined {
  const envVar = config.providers.venice?.api_key_env ?? "VENICE_API_KEY";
  return process.env[envVar];
}

export type ModelRole = "summary" | "match" | "embed" | "translate";

/**
 * Effective privacy requirement for a model role: the per-role
 * `models.<role>.require_private` override when set, else the provider-level
 * `providers.venice.require_private` (default true — today's behavior).
 */
export function roleRequiresPrivate(config: CoordinatorConfig, role: ModelRole): boolean {
  return (
    config.models[role].require_private ?? config.providers.venice?.require_private ?? true
  );
}

/**
 * Assemble the public 31611 announce content from config (docs/COORDINATOR-
 * DISCOVERY-PLAN.md). Per-role privacy reflects the operator's `require_private`
 * intent (relaxed → "non-private", so organizers see which roles leave the TEE).
 * `free_organizers` is deliberately NOT included — it's a private allowlist.
 */
export function buildAnnounceContent(config: CoordinatorConfig): CoordinatorAnnounce {
  const privacy: Record<string, string> = { stt: "private" };
  for (const role of ["summary", "match", "embed", "translate"] as ModelRole[]) {
    privacy[role] = roleRequiresPrivate(config, role) ? "private" : "non-private";
  }
  const p = config.pricing;
  const pricing = {
    model: p.model,
    ...(p.free_up_to_users !== undefined ? { free_up_to_users: p.free_up_to_users } : {}),
    ...(p.summary ? { summary: p.summary } : {}),
    ...(p.checkout_url ? { checkout_url: p.checkout_url } : {}),
    ...(p.currency ? { currency: p.currency } : {}),
  };
  return {
    v: 1,
    name: config.coordinator.name,
    ...(config.coordinator.about ? { about: config.coordinator.about } : {}),
    ...(config.coordinator.picture ? { picture: config.coordinator.picture } : {}),
    ...(config.coordinator.operator ? { operator: config.coordinator.operator } : {}),
    relays: config.relays.default,
    features: { matching: true, talks: true, chat: ["marmot"] },
    privacy,
    ...(config.coordinator.terms_url ? { terms_url: config.coordinator.terms_url } : {}),
    pricing,
  };
}

/** Normalize an npub/hex identity to hex (for the free-organizer allowlist). */
function toHexPubkey(id: string): string | undefined {
  const s = id.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith("npub1")) {
    try {
      const d = decode(s);
      if (d.type === "npub") return d.data;
    } catch {
      /* invalid */
    }
  }
  return undefined;
}

/** True if this organizer is on the always-free allowlist (community events). */
export function isFreeOrganizer(config: CoordinatorConfig, organizerPubkeyHex: string): boolean {
  const target = organizerPubkeyHex.toLowerCase();
  return config.pricing.free_organizers.some((id) => toHexPubkey(id) === target);
}

/**
 * Evaluate the billing state for an event (Part 3). Pure — the caller decides
 * whether/when to emit it in a 21606 status. Default-free config always returns
 * `ok`, so wiring this into the flow is a no-op until an operator sets pricing.
 */
export function evaluateBilling(
  config: CoordinatorConfig,
  organizerPubkeyHex: string | undefined,
  attendeeCount: number,
): CoordinatorBilling {
  if (config.pricing.model === "free") return { state: "ok" };
  if (organizerPubkeyHex && isFreeOrganizer(config, organizerPubkeyHex)) return { state: "ok" };
  const freeUpTo = config.pricing.free_up_to_users;
  if (freeUpTo === undefined || attendeeCount <= freeUpTo) return { state: "ok" };
  return {
    state: "payment_required",
    reason: `Event has ${attendeeCount} attendees, above the ${freeUpTo}-attendee free tier`,
    ...(config.pricing.checkout_url ? { checkout_url: config.pricing.checkout_url } : {}),
    ...(config.pricing.currency ? { currency: config.pricing.currency } : {}),
  };
}
