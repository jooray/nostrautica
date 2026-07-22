/**
 * Per-role provider routing resolution + privacy disclosure (audit H-1, §13.5,
 * §12 item 7). Startup must resolve a concrete provider instance per role, fail
 * closed on unroutable roles and require_private violations, and generate the
 * announcement privacy map from the RESOLVED routes.
 */
import { describe, it, expect } from "vitest";
import { configSchema } from "../config.js";
import { resolveRoleRoutes, disclosureFromRoutes } from "./routes.js";
import { MockLlm } from "./mock.js";
import type { ModelInfo } from "./types.js";

function config(models: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return configSchema.parse({
    relays: { default: ["wss://r"] },
    models,
    ...extra,
  });
}

const silent = { warn: () => {} };

describe("resolveRoleRoutes — per-role provider instances (H-1)", () => {
  it("routes each role to its own configured provider instance", async () => {
    const venice = new MockLlm(() => ({}), { id: "venice", models: [
      { id: "v-summary", private: true },
      { id: "v-translate", private: true },
    ] });
    const routstr = new MockLlm(() => ({}), { id: "routstr", models: [
      { id: "r-match", private: false },
      { id: "r-embed", private: false },
    ] });
    const cfg = config({
      summary: { provider: "venice", model: "v-summary" },
      match: { provider: "routstr", model: "r-match", require_private: false },
      embed: { provider: "routstr", model: "r-embed", require_private: false },
      translate: { provider: "venice", model: "v-translate" },
    });
    const routes = await resolveRoleRoutes(cfg, { providers: { venice, routstr }, logger: silent });
    expect(routes.summary.llm).toBe(venice);
    expect(routes.translate.llm).toBe(venice);
    expect(routes.match.llm).toBe(routstr);
    expect(routes.embed.llm).toBe(routstr);
    expect(routes.summary.provider).toBe("venice");
    expect(routes.match.provider).toBe("routstr");
  });

  it("generates the announcement privacy map from the RESOLVED (verified) routes", async () => {
    const venice = new MockLlm(() => ({}), { id: "venice", models: [{ id: "v-summary", private: true }, { id: "v-translate", private: true }] });
    const routstr = new MockLlm(() => ({}), { id: "routstr", models: [{ id: "r-match", private: false }, { id: "r-embed", private: false }] });
    const cfg = config({
      summary: { provider: "venice", model: "v-summary" },
      match: { provider: "routstr", model: "r-match", require_private: false },
      embed: { provider: "routstr", model: "r-embed", require_private: false },
      translate: { provider: "venice", model: "v-translate" },
    });
    const routes = await resolveRoleRoutes(cfg, { providers: { venice, routstr }, logger: silent });
    const privacy = disclosureFromRoutes(routes);
    expect(privacy).toEqual({
      stt: "private",
      summary: "private",
      match: "non-private", // routstr non-private model, verified from the catalogue
      embed: "non-private",
      translate: "private",
    });
  });

  it("fails startup when a require_private role resolves to a non-private model", async () => {
    const venice = new MockLlm(() => ({}), { id: "venice", models: [{ id: "leaky", private: false }] });
    const cfg = config({
      summary: { provider: "venice", model: "leaky" }, // require_private defaults true
      match: { provider: "venice", model: "leaky" },
      embed: { provider: "venice", model: "leaky" },
      translate: { provider: "venice", model: "leaky" },
    });
    await expect(resolveRoleRoutes(cfg, { providers: { venice }, logger: silent })).rejects.toThrow(
      /not a private\/TEE-tier/,
    );
  });

  it("fails startup when a role references a provider that is not configured", async () => {
    const venice = new MockLlm(() => ({}), { id: "venice", models: [{ id: "m", private: true }] });
    const cfg = config({
      summary: { provider: "venice", model: "m" },
      match: { provider: "routstr", model: "m" }, // routstr not constructed (no node_url)
      embed: { provider: "venice", model: "m" },
      translate: { provider: "venice", model: "m" },
    });
    await expect(resolveRoleRoutes(cfg, { providers: { venice }, logger: silent })).rejects.toThrow(
      /provider "routstr" which is not configured/,
    );
  });

  it("a one-provider catalogue outage fails closed only for that provider's private roles", async () => {
    const venice = new MockLlm(() => ({}), { id: "venice", modelsThrows: true });
    const cfg = config({
      summary: { provider: "venice", model: "m" }, // require_private true → fail closed
      match: { provider: "venice", model: "m" },
      embed: { provider: "venice", model: "m" },
      translate: { provider: "venice", model: "m" },
    });
    await expect(resolveRoleRoutes(cfg, { providers: { venice }, logger: silent })).rejects.toThrow(
      /catalogue unfetchable/,
    );
  });

  it("a catalogue outage boots (unverified) when the role does not require private", async () => {
    const routstr = new MockLlm(() => ({}), { id: "routstr", modelsThrows: true });
    const cfg = config({
      summary: { provider: "routstr", model: "m", require_private: false },
      match: { provider: "routstr", model: "m", require_private: false },
      embed: { provider: "routstr", model: "m", require_private: false },
      translate: { provider: "routstr", model: "m", require_private: false },
    });
    const routes = await resolveRoleRoutes(cfg, { providers: { routstr }, logger: silent });
    expect(routes.summary.privacy).toBe("non-private");
  });

  it("a catalogue outage with the explicit escape hatch boots even a private role", async () => {
    const venice = new MockLlm(() => ({}), { id: "venice", modelsThrows: true });
    const cfg = config({
      summary: { provider: "venice", model: "m" },
      match: { provider: "venice", model: "m" },
      embed: { provider: "venice", model: "m" },
      translate: { provider: "venice", model: "m" },
    });
    const routes = await resolveRoleRoutes(cfg, {
      providers: { venice },
      logger: silent,
      allowUnverified: true,
    });
    expect(routes.summary.privacy).toBe("private"); // falls back to intent
  });
});

describe("catalogue is fetched once per distinct provider", () => {
  it("queries each provider instance a single time regardless of role count", async () => {
    let veniceCalls = 0;
    const venice = new MockLlm(() => ({}), { id: "venice", models: [{ id: "m", private: true }] });
    const origModels = venice.models.bind(venice);
    venice.models = async (): Promise<ModelInfo[]> => {
      veniceCalls++;
      return origModels();
    };
    const cfg = config({
      summary: { provider: "venice", model: "m" },
      match: { provider: "venice", model: "m" },
      embed: { provider: "venice", model: "m" },
      translate: { provider: "venice", model: "m" },
    });
    await resolveRoleRoutes(cfg, { providers: { venice }, logger: silent });
    expect(veniceCalls).toBe(1);
  });
});
