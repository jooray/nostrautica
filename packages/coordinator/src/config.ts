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
import { hexToBytes } from "@nostrautica/protocol";

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
