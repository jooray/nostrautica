/**
 * Coordinator configuration (spec §9.5). Loaded from coordinator.toml + env
 * secrets. Installation is protocol-level (21603 grant), so there is no per-event
 * server config here — only the daemon's identity, providers, and matching knobs.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { isBlockedAddress } from "./net/safe-fetch.js";
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
      // Event identities (E_id: npub or hex pubkey) that are ALWAYS free — the
      // billing principal in v2 is the event identity (spec §9, D5: v1's
      // `free_organizers` was a misnomer; nothing authenticated a personal
      // organizer). Private — evaluated at billing time, never in the public announce.
      free_eids: z.array(z.string()).default([]),
      // Optional grace window (seconds) before a paying-over-tier event is BLOCKED:
      // on first exceeding the free tier the event enters `grace` (paid work still
      // runs) until now+grace_period_sec, then transitions to `blocked`. Absent ⇒ no
      // grace (straight to blocked). Keeps the evaluating→grace→blocked path real.
      grace_period_sec: z.number().int().nonnegative().optional(),
    })
    .default({}),
  // Per-attendee / per-event usage budgets (spec §8, audit H-2). Generous abuse
  // ceilings, NOT product limits — exceeding one parks further paid processing for
  // that attendee/event (same waiting-state as a billing block) and emits a 21606
  // `budget_exceeded`. An organizer reprocess/recompute after a config raise (which
  // reloads these) resumes. Any limit set to 0 means "unlimited".
  budgets: z
    .object({
      /** Actual downloaded ciphertext bytes. Default 2 GiB / attendee, 50 GiB / event. */
      per_attendee_bytes: z.number().int().nonnegative().default(2 * 1024 * 1024 * 1024),
      per_event_bytes: z.number().int().nonnegative().default(50 * 1024 * 1024 * 1024),
      /** Decoded media seconds (probed). Default 4 h / attendee, 200 h / event. */
      per_attendee_duration_sec: z.number().int().nonnegative().default(4 * 3600),
      per_event_duration_sec: z.number().int().nonnegative().default(200 * 3600),
      /** Provider spend attempts (paid job executions). Default 500 / attendee, 20k / event. */
      per_attendee_calls: z.number().int().nonnegative().default(500),
      per_event_calls: z.number().int().nonnegative().default(20_000),
    })
    .default({}),
  // Daemon-side security policy (audit COORD-3/COORD-20). Install is
  // protocol-level, so unsolicited 21603 grants are bounded here.
  security: z
    .object({
      /** Max simultaneously installed events; installs beyond the cap are rejected. */
      max_events: z.number().int().positive().default(50),
      /**
       * When non-empty, only install events whose E_id (hex pubkey) is listed.
       * Empty (default) = accept any E_id-authenticated install.
       */
      allowed_eid_pubkeys: z.array(z.string()).default([]),
      /**
       * Escape hatch for startup model-privacy verification (audit COORD-20):
       * when GET /models can't be fetched, startup normally ABORTS if any role
       * has require_private (fail closed). Set true to boot anyway (warn only).
       */
      allow_unverified_model_privacy: z.boolean().default(false),
      /**
       * Operator relay allowlist (audit C4). When non-empty, ANY relay URL taken
       * from untrusted event input (config `relays`, grant `config_relays`, inbox
       * NIP-65 lists, key-package discovery) is dropped unless its host is listed.
       * Empty (default) = accept any PUBLIC wss:// relay (still SSRF-guarded).
       */
      relay_allowlist: z.array(z.string()).default([]),
      /**
       * DEV-ONLY escape hatch (audit C4 + O4). Permits insecure/local endpoints that
       * are otherwise rejected: `http://`/`ws://` schemes, and loopback/private/
       * link-local hosts — for provider URLs AND for relay WebSockets. NEVER set this
       * on a public coordinator; it exists so a local test stack (a self-signed
       * Blossom proxy, a `nak serve` on localhost) can run. Default false.
       */
      allow_insecure_urls: z.boolean().default(false),
    })
    .default({}),
});

export type CoordinatorConfig = z.infer<typeof configSchema>;

/** True for a hostname literal that is loopback/private/link-local/unspecified — the
 *  set the SSRF guard rejects (audit O4). Hostnames that must be resolved (DNS names)
 *  are NOT flagged here: operator-authored provider/relay config is trusted enough to
 *  resolve at connect time (relay connections are additionally pinned, audit C4). */
function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) !== 0) return isBlockedAddress(h);
  return false;
}

/**
 * Validate + normalize a configured URL (audit O4). Requires the expected secure
 * scheme (`https:` for HTTP endpoints, `wss:` for relays), rejects embedded
 * credentials and URL fragments, and rejects loopback/private hosts — unless the
 * operator set `security.allow_insecure_urls` (dev only), which also permits the
 * plaintext `http:`/`ws:` scheme. Returns the normalized URL string. Throws a
 * clear, labelled error the operator sees at startup / in `doctor`.
 */
export function validateConfiguredUrl(
  raw: string,
  opts: { kind: "http" | "ws"; allowInsecure: boolean; label: string },
): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${opts.label}: not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (u.username || u.password) {
    throw new Error(`${opts.label}: URL must not embed credentials (${u.protocol}//user:pass@…)`);
  }
  if (u.hash) {
    throw new Error(`${opts.label}: URL must not contain a fragment (#…)`);
  }
  const secure = opts.kind === "http" ? "https:" : "wss:";
  const insecure = opts.kind === "http" ? "http:" : "ws:";
  if (u.protocol === secure) {
    // ok
  } else if (u.protocol === insecure && opts.allowInsecure) {
    // ok — dev-only insecure scheme
  } else {
    throw new Error(
      `${opts.label}: must be ${secure} (got ${u.protocol})${u.protocol === insecure ? " — set security.allow_insecure_urls for local dev only" : ""}`,
    );
  }
  if (!opts.allowInsecure && isLocalOrPrivateHost(u.hostname)) {
    throw new Error(
      `${opts.label}: refuses loopback/private host ${u.hostname} — set security.allow_insecure_urls for local dev only`,
    );
  }
  return u.toString();
}

/**
 * Validate every operator-configured public URL at load (audit O4): provider base
 * URLs, Routstr node/mint, terms/checkout links, and the default relays. Fails
 * fast with a labelled error rather than letting a Venice bearer key or attendee
 * prompt flow to a cleartext or unintended endpoint. Mutates `config` in place with
 * the normalized values.
 */
function validateConfigUrls(config: CoordinatorConfig): void {
  const allowInsecure = config.security.allow_insecure_urls;
  const http = (raw: string, label: string) => validateConfiguredUrl(raw, { kind: "http", allowInsecure, label });
  const ws = (raw: string, label: string) => validateConfiguredUrl(raw, { kind: "ws", allowInsecure, label });

  if (config.providers.venice?.base_url) {
    config.providers.venice.base_url = http(config.providers.venice.base_url, "providers.venice.base_url");
  }
  if (config.providers.routstr?.node_url) {
    config.providers.routstr.node_url = http(config.providers.routstr.node_url, "providers.routstr.node_url");
  }
  if (config.providers.routstr?.mint) {
    config.providers.routstr.mint = http(config.providers.routstr.mint, "providers.routstr.mint");
  }
  if (config.coordinator.terms_url) {
    config.coordinator.terms_url = http(config.coordinator.terms_url, "coordinator.terms_url");
  }
  if (config.coordinator.picture) {
    config.coordinator.picture = http(config.coordinator.picture, "coordinator.picture");
  }
  if (config.pricing.checkout_url) {
    config.pricing.checkout_url = http(config.pricing.checkout_url, "pricing.checkout_url");
  }
  config.relays.default = config.relays.default.map((r, i) => ws(r, `relays.default[${i}]`));
}

export function loadConfig(path: string): CoordinatorConfig {
  const raw = parseToml(readFileSync(path, "utf8"));
  const config = configSchema.parse(raw);
  validateConfigUrls(config);
  return config;
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
export function buildAnnounceContent(
  config: CoordinatorConfig,
  privacyOverride?: Record<string, string>,
): CoordinatorAnnounce {
  // Privacy disclosure is generated from the RESOLVED runtime routes when provided
  // (audit H-1, §13.5) — where data actually flows, with verified tiers — falling
  // back to config intent only when routes haven't been resolved (e.g. announce
  // disabled paths). `privacyOverride` is `disclosureFromRoutes(routes)`.
  const privacy: Record<string, string> = privacyOverride ?? { stt: "private" };
  if (!privacyOverride) {
    for (const role of ["summary", "match", "embed", "translate"] as ModelRole[]) {
      privacy[role] = roleRequiresPrivate(config, role) ? "private" : "non-private";
    }
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
    v: 2,
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

/** True if this event identity (E_id) is on the always-free allowlist (spec §9 D5). */
export function isFreeEid(config: CoordinatorConfig, eidPubkeyHex: string): boolean {
  const target = eidPubkeyHex.toLowerCase();
  return config.pricing.free_eids.some((id) => toHexPubkey(id) === target);
}

/**
 * Evaluate the billing state for an event (spec §9). Pure — the caller decides
 * whether/when to emit it in a 21606 status and how to map it onto the persisted
 * `evaluating→ok|grace|blocked` state machine. Default-free config always returns
 * `ok`. `eidPubkeyHex` is the BILLING PRINCIPAL (the event identity, D5).
 */
export function evaluateBilling(
  config: CoordinatorConfig,
  eidPubkeyHex: string | undefined,
  attendeeCount: number,
): CoordinatorBilling {
  if (config.pricing.model === "free") return { state: "ok" };
  if (eidPubkeyHex && isFreeEid(config, eidPubkeyHex)) return { state: "ok" };
  const freeUpTo = config.pricing.free_up_to_users;
  if (freeUpTo === undefined || attendeeCount <= freeUpTo) return { state: "ok" };
  return {
    state: "payment_required",
    reason: `Event has ${attendeeCount} attendees, above the ${freeUpTo}-attendee free tier`,
    ...(config.pricing.checkout_url ? { checkout_url: config.pricing.checkout_url } : {}),
    ...(config.pricing.currency ? { currency: config.pricing.currency } : {}),
  };
}
