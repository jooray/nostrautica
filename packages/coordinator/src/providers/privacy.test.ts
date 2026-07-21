/**
 * Per-role model-privacy verification (spec §16.2/§16.4, audit H6). The
 * `models.<role>.require_private` override must win over the provider default, and
 * startup verification must fail closed for a required-private role on a public
 * model while only warning for an operator-accepted non-private tier.
 */
import { describe, it, expect, vi } from "vitest";
import { configSchema, roleRequiresPrivate, type CoordinatorConfig } from "../config.js";
import { verifyModelPrivacy } from "./privacy.js";
import type { LlmProvider, ModelInfo } from "./types.js";

function makeConfig(over: Record<string, unknown> = {}): CoordinatorConfig {
  return configSchema.parse({
    relays: { default: ["wss://relay.example"] },
    providers: { venice: { require_private: true } },
    models: {
      summary: { provider: "venice", model: "summary-private" },
      match: { provider: "venice", model: "match-public", require_private: false },
      embed: { provider: "venice", model: "embed-private" },
      ...over,
    },
  });
}

function mockLlm(models: ModelInfo[]): LlmProvider {
  return {
    id: "venice",
    models: async () => models,
    completeStructured: async () => ({ value: {} as any, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
  };
}

describe("roleRequiresPrivate (spec §16.2 knob)", () => {
  it("uses the per-role override when present, else the provider default", () => {
    const cfg = makeConfig();
    // summary: no override → provider default true
    expect(roleRequiresPrivate(cfg, "summary")).toBe(true);
    // match: override false → false (the accepted non-private match tier)
    expect(roleRequiresPrivate(cfg, "match")).toBe(false);
  });

  it("a provider default of false is inherited by roles without an override", () => {
    const cfg = configSchema.parse({
      relays: { default: ["wss://r"] },
      providers: { venice: { require_private: false } },
      models: {
        summary: { provider: "venice", model: "s" },
        match: { provider: "venice", model: "m" },
        embed: { provider: "venice", model: "e" },
      },
    });
    expect(roleRequiresPrivate(cfg, "summary")).toBe(false);
  });
});

describe("verifyModelPrivacy (spec §16.4 startup check)", () => {
  const catalogue: ModelInfo[] = [
    { id: "summary-private", private: true },
    { id: "match-public", private: false },
    { id: "embed-private", private: true },
    { id: "gemini-3-flash-preview", private: true }, // default translate model
  ];

  it("passes and warns for an accepted non-private role (require_private=false)", async () => {
    const warn = vi.fn();
    await expect(verifyModelPrivacy(mockLlm(catalogue), makeConfig(), { warn })).resolves.toBeUndefined();
    // match runs on a public model but is explicitly accepted → warning, not error.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('models.match'));
  });

  it("fails closed when a required-private role points at a public model", async () => {
    // summary requires private (provider default) but is a public model → hard error.
    const cfg = makeConfig({ summary: { provider: "venice", model: "match-public" } });
    await expect(verifyModelPrivacy(mockLlm(catalogue), cfg, { warn: vi.fn() })).rejects.toThrow(/not a Venice private/);
  });

  it("only warns when a model id is absent from the catalogue (volatile ids)", async () => {
    const warn = vi.fn();
    const cfg = makeConfig({ summary: { provider: "venice", model: "ghost-model" } });
    await expect(verifyModelPrivacy(mockLlm(catalogue), cfg, { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not found in GET /models"));
  });

  it("does NOT warn for an embed model absent from GET /models (separate catalogue)", async () => {
    const warn = vi.fn();
    // Embedding models live on `/models?type=embedding`, not GET /models, so an
    // absent embed id is expected — must not produce a scary boot warning.
    const cfg = makeConfig({ embed: { provider: "venice", model: "text-embedding-bge-m3" } });
    await expect(verifyModelPrivacy(mockLlm(catalogue), cfg, { warn })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("not found in GET /models"));
  });

  it("does not verify non-venice roles", async () => {
    const cfg = makeConfig({ summary: { provider: "routstr", model: "whatever" } });
    // routstr summary is skipped; match is accepted-public → resolves.
    await expect(verifyModelPrivacy(mockLlm(catalogue), cfg, { warn: vi.fn() })).resolves.toBeUndefined();
  });
});

describe("verifyModelPrivacy — catalogue unfetchable (audit COORD-20, fail closed)", () => {
  const failingLlm: LlmProvider = {
    id: "venice",
    models: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    completeStructured: async () => ({ value: {} as any, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
  };

  it("ABORTS startup when a require_private role can't be verified", async () => {
    // summary has require_private (provider default true) → fail closed.
    await expect(verifyModelPrivacy(failingLlm, makeConfig(), { warn: vi.fn() })).rejects.toThrow(
      /could not verify model privacy/,
    );
  });

  it("boots with a warning when NO role requires private", async () => {
    const warn = vi.fn();
    const cfg = configSchema.parse({
      relays: { default: ["wss://r"] },
      providers: { venice: { require_private: false } },
      models: {
        summary: { provider: "venice", model: "s" },
        match: { provider: "venice", model: "m" },
        embed: { provider: "venice", model: "e" },
      },
    });
    await expect(verifyModelPrivacy(failingLlm, cfg, { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not verify model privacy"));
  });

  it("the explicit escape hatch (allowUnverified) boots with a warning", async () => {
    const warn = vi.fn();
    await expect(
      verifyModelPrivacy(failingLlm, makeConfig(), { warn }, { allowUnverified: true }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not verify model privacy"));
  });
});
