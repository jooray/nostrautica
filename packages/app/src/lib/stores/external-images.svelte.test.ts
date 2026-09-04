/**
 * SEC-17. A kind-0 `picture` — or a banner, or an image URL inside a note — is
 * chosen by whoever wrote the record, and the app renders it as `<img src>`
 * fetched by the VIEWER's browser. An attendee opening a roster of forty people
 * hands their IP, user-agent and a precise timestamp to forty hosts they never
 * chose, and anyone who can get an npub into a member list can turn that into a
 * beacon. The talk player already treats this as a real disclosure and gates
 * playback behind a click; avatars cannot use that gate, so the policy is
 * layered instead — and this pins the layers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { safeImageSrc, externalImages, setExternalImagesAllowed } from "./external-images.svelte.js";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("location", { href: "https://app.example/e/naddr1/attendees", origin: "https://app.example" });
  setExternalImagesAllowed(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SEC-17 third-party image policy", () => {
  it("allows an ordinary https profile picture", () => {
    expect(safeImageSrc("https://cdn.example/pic.jpg")).toBe("https://cdn.example/pic.jpg");
  });

  it("refuses every scheme that is not https", () => {
    // http would leak the same data in the clear; data:/blob: have no business
    // arriving from the wire; javascript: does not execute in an img but has no
    // reason to reach the DOM either.
    expect(safeImageSrc("http://cdn.example/pic.jpg")).toBeUndefined();
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBeUndefined();
    expect(safeImageSrc("blob:https://app.example/abc")).toBeUndefined();
    expect(safeImageSrc("javascript:alert(1)")).toBeUndefined();
    expect(safeImageSrc("")).toBeUndefined();
    expect(safeImageSrc(undefined)).toBeUndefined();
    // Relative/garbage is rejected, not resolved against the current page — the
    // app never passes its own artwork through here, so a relative string
    // arriving is malformed wire data, and resolving it would turn a junk
    // `picture` field into a same-origin request.
    expect(safeImageSrc("not a url at all")).toBeUndefined();
    expect(safeImageSrc("/icon-192.png")).toBeUndefined();
  });

  it("keeps same-origin images regardless of the setting", () => {
    // The app's own assets disclose nothing that loading the page did not, so
    // turning third-party images off must not blank out the app's own artwork.
    setExternalImagesAllowed(false);
    expect(safeImageSrc("https://app.example/icon-192.png")).toBe("https://app.example/icon-192.png");
  });

  it("refuses every off-origin image once the viewer opts out", () => {
    setExternalImagesAllowed(false);
    expect(externalImages.allowed).toBe(false);
    expect(safeImageSrc("https://cdn.example/pic.jpg")).toBeUndefined();
  });

  it("defaults to allowing, and remembers an opt-out across a reload", () => {
    // Default ON: the alternative silently degrades every roster for everyone.
    store.clear();
    expect(externalImages.allowed).toBe(true);
    setExternalImagesAllowed(false);
    expect(store.get("nostrautica:external-images")).toBe("0");
  });

  it("still answers when storage throws, rather than taking the page down", () => {
    // Private mode / blocked site data: reading or writing localStorage throws.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => setExternalImagesAllowed(false)).not.toThrow();
    expect(safeImageSrc("https://cdn.example/pic.jpg")).toBeUndefined();
  });
});
