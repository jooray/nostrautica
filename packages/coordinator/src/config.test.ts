/**
 * Provider / public URL validation at config load (audit O4): every operator URL
 * must be https/wss, carry no credentials or fragment, and name a public host —
 * insecure/local endpoints only behind the explicit dev flag.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfiguredUrl, spendExposure, type UnknownConfigKey } from "./config.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nostrautica-cfg-"));
  tmpDirs.push(dir);
  const path = join(dir, "coordinator.toml");
  writeFileSync(path, body);
  return path;
}

const BASE = `
[relays]
default = ["wss://relay.example"]

[models]
summary = { provider = "venice", model = "m" }
match = { provider = "venice", model = "m" }
embed = { provider = "venice", model = "m" }
`;

describe("validateConfiguredUrl (audit O4)", () => {
  const ok = { allowInsecure: false, label: "test" };
  it("accepts a clean https URL and rejects http by default", () => {
    expect(validateConfiguredUrl("https://api.example/v1", { ...ok, kind: "http" })).toBe("https://api.example/v1");
    expect(() => validateConfiguredUrl("http://api.example", { ...ok, kind: "http" })).toThrow(/must be https:/);
  });
  it("rejects credentials and fragments", () => {
    expect(() => validateConfiguredUrl("https://u:p@api.example", { ...ok, kind: "http" })).toThrow(/credentials/);
    expect(() => validateConfiguredUrl("https://api.example/#x", { ...ok, kind: "http" })).toThrow(/fragment/);
  });
  it("rejects loopback/private hosts unless the dev flag is set", () => {
    expect(() => validateConfiguredUrl("https://127.0.0.1", { ...ok, kind: "http" })).toThrow(/loopback\/private/);
    expect(() => validateConfiguredUrl("https://localhost:3000", { ...ok, kind: "http" })).toThrow(/loopback\/private/);
    expect(validateConfiguredUrl("http://localhost:3000/", { allowInsecure: true, kind: "http", label: "t" })).toBe(
      "http://localhost:3000/",
    );
  });
  it("requires wss for relays", () => {
    expect(validateConfiguredUrl("wss://relay.example", { ...ok, kind: "ws" })).toBe("wss://relay.example/");
    expect(() => validateConfiguredUrl("ws://relay.example", { ...ok, kind: "ws" })).toThrow(/must be wss:/);
  });
});

describe("loadConfig URL validation (audit O4)", () => {
  it("loads a clean config", () => {
    const cfg = loadConfig(writeConfig(BASE));
    expect(cfg.relays.default).toEqual(["wss://relay.example/"]);
  });
  it("rejects an http Venice base_url", () => {
    const body = BASE + `\n[providers.venice]\nbase_url = "http://api.venice.ai/api/v1"\n`;
    expect(() => loadConfig(writeConfig(body))).toThrow(/providers.venice.base_url.*must be https:/s);
  });
  it("rejects a ws:// default relay", () => {
    const body = `
[relays]
default = ["ws://relay.example"]
[models]
summary = { provider = "venice", model = "m" }
match = { provider = "venice", model = "m" }
embed = { provider = "venice", model = "m" }
`;
    expect(() => loadConfig(writeConfig(body))).toThrow(/relays.default\[0\].*must be wss:/s);
  });
  it("accepts a local relay + http provider under the dev flag", () => {
    const body = `
[relays]
default = ["ws://127.0.0.1:7777"]
[models]
summary = { provider = "venice", model = "m" }
match = { provider = "venice", model = "m" }
embed = { provider = "venice", model = "m" }
[providers.venice]
base_url = "http://localhost:3000/v1"
[security]
allow_insecure_urls = true
`;
    const cfg = loadConfig(writeConfig(body));
    expect(cfg.providers.venice?.base_url).toBe("http://localhost:3000/v1");
    expect(cfg.relays.default).toEqual(["ws://127.0.0.1:7777/"]);
  });
});


/**
 * A mistyped or renamed config key used to vanish without a trace: the schema
 * objects were non-strict, so zod dropped the key and reported nothing. That is
 * how `pricing.free_organizers` (renamed to `free_eids` in spec §9 D5, and left
 * stale in the example TOML) got uncommented on a live coordinator and produced no
 * allowlist, no error and no log — the event crossed the free tier into `grace`,
 * then `blocked`, and every paid job for it parked mid-event.
 */
describe("unknown config keys are loud", () => {
  it("reports a renamed key by its full path and still loads", () => {
    const body = BASE + `\n[pricing]\nmodel = "per_user"\nfree_organizers = ["abc"]\n`;
    const seen: UnknownConfigKey[] = [];
    const cfg = loadConfig(writeConfig(body), { onUnknownKeys: (k) => seen.push(...k) });
    expect(seen.map((u) => u.path)).toEqual(["pricing.free_organizers"]);
    expect(seen[0]!.section).toBe("pricing");
    // Dropped, as before — but now the operator is told, instead of watching an
    // allowlist they believe is in effect do nothing.
    expect(cfg.pricing.free_eids).toEqual([]);
    expect(cfg.pricing.model).toBe("per_user");
  });

  it("reports a top-level table nobody knows", () => {
    const body = BASE + `\n[matchmaking]\ntop_k = 5\n`;
    const seen: UnknownConfigKey[] = [];
    loadConfig(writeConfig(body), { onUnknownKeys: (k) => seen.push(...k) });
    expect(seen.map((u) => u.path)).toEqual(["matchmaking"]);
  });

  it("reports several unknown keys at once, across sections", () => {
    const body =
      BASE + `\n[matching]\ntop_kk = 5\nprefilter_topm = 3\n\n[security]\nmax_event = 1\n`;
    const seen: UnknownConfigKey[] = [];
    const cfg = loadConfig(writeConfig(body), { onUnknownKeys: (k) => seen.push(...k) });
    expect(seen.map((u) => u.path).sort()).toEqual([
      "matching.prefilter_topm",
      "matching.top_kk",
      "security.max_event",
    ]);
    expect(cfg.matching.top_k).toBe(20); // the default, because the typo set nothing
    expect(cfg.security.max_events).toBe(50);
  });

  it("warns on the console when no handler is supplied (the daemon path)", () => {
    const body = BASE + `\n[coordinator]\nnaem = "typo"\n`;
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m: unknown) => void warned.push(String(m)));
    try {
      loadConfig(writeConfig(body));
    } finally {
      spy.mockRestore();
    }
    expect(warned.join("\n")).toMatch(/UNKNOWN KEY coordinator\.naem/);
  });

  it("a REAL validation error still throws (an unknown key is not a licence to ignore)", () => {
    const body = `
[relays]
default = ["wss://relay.example"]
[models]
summary = { provider = "venice", model = "m" }
match = { provider = "venice", model = "m" }
[matching]
bogus = 1
`;
    // `models.embed` is missing — that is a schema violation, not a stray key.
    expect(() => loadConfig(writeConfig(body))).toThrow();
  });
});

describe("matching knobs are counts, not arbitrary numbers", () => {
  it("rejects a negative top_k", () => {
    const body = BASE + `\n[matching]\ntop_k = -1\n`;
    expect(() => loadConfig(writeConfig(body))).toThrow();
  });
  it("rejects a fractional prefilter_top_m", () => {
    const body = BASE + `\n[matching]\nprefilter_top_m = 3.5\n`;
    expect(() => loadConfig(writeConfig(body))).toThrow();
  });
  it("still accepts the shipped example values", () => {
    const body =
      BASE +
      `\n[matching]\nprefilter_threshold = 50\nprefilter_top_m = 30\nprefilter_random = 10\ntop_k = 20\nbatch_size = 10\n`;
    const cfg = loadConfig(writeConfig(body));
    expect(cfg.matching).toEqual({
      prefilter_threshold: 50,
      prefilter_top_m: 30,
      prefilter_random: 10,
      top_k: 20,
      batch_size: 10,
    });
  });
});

/**
 * SEC-7. The per-event budgets bound one installation, and install is
 * protocol-level: an announced coordinator that accepts any E_id hands out as
 * many of those budgets as `security.max_events` allows, all drawn on one
 * provider key. This is the startup gate that refuses that shape.
 */
describe("SEC-7 spend exposure at startup", () => {
  it("passes with the shipped defaults, which carry a daemon-wide ceiling", () => {
    const cfg = loadConfig(writeConfig(BASE));
    // Announced and open to any installer — the normal public-coordinator shape —
    // but bounded, so it boots.
    expect(cfg.coordinator.announce).toBe(true);
    expect(cfg.security.allowed_eid_pubkeys).toEqual([]);
    expect(spendExposure(cfg)).toBeUndefined();
  });

  it("flags an announced, open coordinator whose daemon budgets are all zeroed", () => {
    const body =
      BASE +
      `\n[budgets]\ndaemon_bytes_per_window = 0\ndaemon_duration_sec_per_window = 0\ndaemon_calls_per_window = 0\n`;
    const msg = spendExposure(loadConfig(writeConfig(body)));
    expect(msg).toBeDefined();
    // The message has to name the way out, not just the problem — an operator
    // hitting this at 3am needs the knob, not a lecture.
    expect(msg).toMatch(/allowed_eid_pubkeys/);
    expect(msg).toMatch(/announce/);
  });

  it("clears once ANY of the three conditions no longer holds", () => {
    const zeroed = `\n[budgets]\ndaemon_bytes_per_window = 0\ndaemon_duration_sec_per_window = 0\ndaemon_calls_per_window = 0\n`;
    // Not announced: nobody can discover it to install against it.
    expect(spendExposure(loadConfig(writeConfig(BASE + zeroed + `\n[coordinator]\nannounce = false\n`)))).toBeUndefined();
    // Restricted installs: only known organizers get a budget at all.
    const allowed = `\n[security]\nallowed_eid_pubkeys = ["${"a".repeat(64)}"]\n`;
    expect(spendExposure(loadConfig(writeConfig(BASE + zeroed + allowed)))).toBeUndefined();
    // One ceiling left standing is enough to bound the total.
    const oneLimit = `\n[budgets]\ndaemon_bytes_per_window = 0\ndaemon_duration_sec_per_window = 0\ndaemon_calls_per_window = 1000\n`;
    expect(spendExposure(loadConfig(writeConfig(BASE + oneLimit)))).toBeUndefined();
  });
});
