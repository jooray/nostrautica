/**
 * Provider / public URL validation at config load (audit O4): every operator URL
 * must be https/wss, carry no credentials or fragment, and name a public host —
 * insecure/local endpoints only behind the explicit dev flag.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfiguredUrl } from "./config.js";

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
