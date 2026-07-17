/**
 * Coordinator discovery + billing (docs/COORDINATOR-DISCOVERY-PLAN.md): the
 * public announce reflects config (and hides the free-organizer allowlist), and
 * billing evaluation honours the free default, per-user tiers, and the community
 * allowlist.
 */
import { describe, it, expect } from "vitest";
import {
  configSchema,
  buildAnnounceContent,
  evaluateBilling,
  isFreeOrganizer,
  type CoordinatorConfig,
} from "./config.js";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { coordinatorAnnounceSchema } from "@nostrautica/protocol";

function cfg(over: Record<string, unknown> = {}): CoordinatorConfig {
  return configSchema.parse({
    relays: { default: ["wss://relay.example"] },
    providers: { venice: { require_private: true } },
    models: {
      summary: { provider: "venice", model: "s" },
      match: { provider: "venice", model: "m", require_private: false },
      embed: { provider: "venice", model: "e" },
    },
    ...over,
  });
}

describe("buildAnnounceContent", () => {
  it("produces a schema-valid announce with per-role privacy disclosure", () => {
    const a = buildAnnounceContent(cfg({ coordinator: { name: "Test Coord" } }));
    expect(() => coordinatorAnnounceSchema.parse(a)).not.toThrow();
    expect(a.name).toBe("Test Coord");
    // match relaxed to non-private; others required-private.
    expect(a.privacy?.match).toBe("non-private");
    expect(a.privacy?.summary).toBe("private");
    expect(a.features).toMatchObject({ matching: true, chat: ["marmot"] });
    expect(a.pricing?.model).toBe("free");
  });

  it("NEVER leaks the free-organizer allowlist into the public announce", () => {
    const a = buildAnnounceContent(
      cfg({ pricing: { model: "per_user", free_organizers: ["npub1free"] } }),
    );
    expect(JSON.stringify(a)).not.toContain("free_organizers");
    expect(JSON.stringify(a)).not.toContain("npub1free");
  });

  it("carries pricing summary + checkout_url when set", () => {
    const a = buildAnnounceContent(
      cfg({
        pricing: {
          model: "per_user",
          free_up_to_users: 20,
          summary: "Free up to 20",
          checkout_url: "https://pay.example/checkout",
        },
      }),
    );
    expect(a.pricing).toMatchObject({
      model: "per_user",
      free_up_to_users: 20,
      summary: "Free up to 20",
      checkout_url: "https://pay.example/checkout",
    });
  });
});

describe("evaluateBilling", () => {
  it("free model is always ok", () => {
    expect(evaluateBilling(cfg(), "a".repeat(64), 9999).state).toBe("ok");
  });

  it("per-user under the free tier is ok, above it requires payment", () => {
    const c = cfg({ pricing: { model: "per_user", free_up_to_users: 20, checkout_url: "https://pay/x" } });
    expect(evaluateBilling(c, "a".repeat(64), 20).state).toBe("ok");
    const over = evaluateBilling(c, "a".repeat(64), 21);
    expect(over.state).toBe("payment_required");
    expect(over.checkout_url).toBe("https://pay/x");
    expect(over.reason).toContain("21");
  });

  it("an allowlisted organizer is always free (npub or hex)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const c = cfg({
      pricing: { model: "per_user", free_up_to_users: 1, free_organizers: [npubEncode(pk)] },
    });
    expect(isFreeOrganizer(c, pk)).toBe(true);
    expect(evaluateBilling(c, pk, 5000).state).toBe("ok");
    // a different organizer over the tier still pays
    expect(evaluateBilling(c, "b".repeat(64), 5000).state).toBe("payment_required");
  });
});
