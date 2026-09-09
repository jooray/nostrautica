/**
 * Third-party image policy (audit SEC-17).
 *
 * A kind-0 `picture`/`banner` is a URL chosen by whoever wrote the profile, and
 * the app renders it as `<img src>` in avatars, event headers, quoted notes and
 * posts. Every one of those is a request from the VIEWER's browser to a host the
 * viewer never chose: an attendee opening a roster of forty people hands their
 * IP, user-agent and a precise timestamp to forty third parties, and anyone who
 * can get an npub into a feed or a member list can turn that into a beacon.
 *
 * The talk player already treats this as a real disclosure and gates playback
 * behind an explicit click (audit U10). Avatars cannot use that gate — a roster
 * of click-to-load circles is not a usable member list — so the policy here is
 * layered instead:
 *
 * 1. **Scheme.** Only `https:` is ever rendered. `http:` would leak the same
 *    data in the clear and trip mixed-content anyway; `data:`/`blob:` have no
 *    business arriving from the wire; `javascript:` does not execute in an `img`
 *    but has no reason to reach the DOM either.
 * 2. **Referrer.** Every such image is loaded with `referrerpolicy="no-referrer"`,
 *    so the host learns that someone fetched the picture but not which event,
 *    page or route they were on — the hash-routed URL in particular can name a
 *    private event.
 * 3. **Consent.** A single setting turns off-origin image loading off entirely,
 *    for a viewer who would rather show initials than contact anyone. Default ON,
 *    because the alternative silently degrades every roster for everyone.
 */

const KEY = "nostrautica:external-images";

/** The referrer policy every third-party image is loaded with. */
export const EXTERNAL_IMG_REFERRER_POLICY = "no-referrer";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true; // no storage (private mode) → behave as the default
  }
}

let allowed = $state<boolean | undefined>(undefined);

export const externalImages = {
  /** Whether off-origin profile images may be requested by this browser. */
  get allowed(): boolean {
    return allowed ?? read();
  },
};

export function setExternalImagesAllowed(next: boolean): void {
  allowed = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private mode: the in-memory value still applies for this session */
  }
}

/**
 * The URL to put in an `<img src>`, or `undefined` to render the fallback.
 *
 * Returns `undefined` for anything that is not an ABSOLUTE `https:` URL, and for
 * every off-origin URL when the viewer has turned third-party images off. Same-
 * origin images are unaffected by the setting — they disclose nothing that
 * loading the page did not. Relative URLs are rejected outright rather than
 * resolved: the app passes its own artwork directly, never through here, so a
 * relative string arriving here is malformed wire data.
 */
export function safeImageSrc(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    // No base. Every URL reaching this function comes from the wire, and
    // resolving relatively would turn a garbage `picture` field into a
    // same-origin request against this app — "not a url at all" would become
    // https://app.example/e/<naddr>/not%20a%20url%20at%20all and be fetched.
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // Scheme FIRST, before any same-origin reasoning. A `blob:` URL reports the
  // inner URL's origin, so an origin check alone would wave through a scheme that
  // has no business arriving from the wire at all.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  // The app's own assets disclose nothing that loading the page did not — and
  // they are served over http by `vite preview`, so this must not be https-only.
  const sameOrigin = typeof location !== "undefined" && parsed.origin === location.origin;
  if (sameOrigin) return parsed.href;
  if (parsed.protocol !== "https:") return undefined;
  if (!externalImages.allowed) return undefined;
  return parsed.href;
}
