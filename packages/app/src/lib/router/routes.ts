/**
 * Hash router (spec §10.1). Reason for hash routing: nsite gateways serve the SPA
 * fallback with HTTP status 404, which breaks history-API deep links; hash routes
 * sidestep that entirely and work on every static host.
 *
 * This module is pure (no DOM) so it can be unit-tested. `parseHash` turns a
 * `location.hash` string into a typed Route; `buildHash` is the inverse.
 */

export type Route =
  | { name: "home" }
  | { name: "login"; nsec?: string }
  | { name: "create" }
  | { name: "me" }
  | { name: "settings" }
  | { name: "event"; naddr: string }
  | { name: "join"; naddr: string; code?: string }
  | { name: "record"; naddr: string; talk: boolean }
  | { name: "attendees"; naddr: string }
  | { name: "attendee"; naddr: string; npub: string }
  | { name: "matches"; naddr: string }
  | { name: "chat"; naddr: string }
  | { name: "talks"; naddr: string }
  | { name: "talk"; naddr: string; d: string }
  | { name: "myProfile"; naddr: string }
  | { name: "admin"; naddr: string }
  | { name: "posts"; naddr: string }
  | { name: "post"; naddr: string; d: string }
  | { name: "eventMore"; naddr: string }
  | { name: "dm" }
  | { name: "dmPeer"; npub: string }
  | { name: "notFound"; hash: string };

/** Split "path?query" from a hash body into path segments + query params. */
function split(body: string): { segments: string[]; query: URLSearchParams } {
  const qIndex = body.indexOf("?");
  const path = qIndex >= 0 ? body.slice(0, qIndex) : body;
  const query = new URLSearchParams(qIndex >= 0 ? body.slice(qIndex + 1) : "");
  const segments = path.split("/").filter((s) => s.length > 0);
  return { segments, query };
}

/**
 * Parse a `location.hash` (e.g. "#/e/naddr1.../matches?foo=bar") into a Route.
 * A leading "#" and/or "/" are tolerated. Unknown paths → notFound.
 */
export function parseHash(hash: string): Route {
  let body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body.startsWith("/")) body = body.slice(1);
  const { segments, query } = split(body);

  if (segments.length === 0) return { name: "home" };

  switch (segments[0]) {
    case "login":
      return { name: "login", nsec: query.get("nsec") ?? undefined };
    case "create":
      return { name: "create" };
    case "me":
      return { name: "me" };
    case "settings":
      return { name: "settings" };
    case "dm": {
      const npub = segments[1];
      return npub ? { name: "dmPeer", npub } : { name: "dm" };
    }
    case "e": {
      const naddr = segments[1];
      if (!naddr) return { name: "notFound", hash };
      const sub = segments[2];
      if (!sub) return { name: "event", naddr };
      switch (sub) {
        case "join":
          return { name: "join", naddr, code: query.get("code") ?? undefined };
        case "record":
          return { name: "record", naddr, talk: query.get("talk") === "1" };
        case "matches":
          return { name: "matches", naddr };
        case "chat":
          return { name: "chat", naddr };
        case "talks": {
          const d = segments[3];
          return d ? { name: "talk", naddr, d } : { name: "talks", naddr };
        }
        case "profile":
          return { name: "myProfile", naddr };
        case "more":
          return { name: "eventMore", naddr };
        case "admin":
          return { name: "admin", naddr };
        case "posts": {
          const d = segments[3];
          return d ? { name: "post", naddr, d } : { name: "posts", naddr };
        }
        case "attendees": {
          const npub = segments[3];
          return npub
            ? { name: "attendee", naddr, npub }
            : { name: "attendees", naddr };
        }
        default:
          return { name: "notFound", hash };
      }
    }
    default:
      return { name: "notFound", hash };
  }
}

/** Build a hash string for a route (inverse of parseHash, for links/navigation). */
export function buildHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "login":
      return route.nsec ? `#/login?nsec=${route.nsec}` : "#/login";
    case "create":
      return "#/create";
    case "me":
      return "#/me";
    case "settings":
      return "#/settings";
    case "event":
      return `#/e/${route.naddr}`;
    case "join":
      return route.code
        ? `#/e/${route.naddr}/join?code=${route.code}`
        : `#/e/${route.naddr}/join`;
    case "record":
      return route.talk
        ? `#/e/${route.naddr}/record?talk=1`
        : `#/e/${route.naddr}/record`;
    case "attendees":
      return `#/e/${route.naddr}/attendees`;
    case "attendee":
      return `#/e/${route.naddr}/attendees/${route.npub}`;
    case "matches":
      return `#/e/${route.naddr}/matches`;
    case "chat":
      return `#/e/${route.naddr}/chat`;
    case "talks":
      return `#/e/${route.naddr}/talks`;
    case "talk":
      return `#/e/${route.naddr}/talks/${route.d}`;
    case "myProfile":
      return `#/e/${route.naddr}/profile`;
    case "eventMore":
      return `#/e/${route.naddr}/more`;
    case "admin":
      return `#/e/${route.naddr}/admin`;
    case "posts":
      return `#/e/${route.naddr}/posts`;
    case "post":
      return `#/e/${route.naddr}/posts/${route.d}`;
    case "dm":
      return "#/dm";
    case "dmPeer":
      return `#/dm/${route.npub}`;
    case "notFound":
      return route.hash;
  }
}

/**
 * Localized document-title message key for a route (audit finding A2). The layout
 * sets `document.title` and announces this on every navigation so screen-reader
 * users get one useful route-change signal and each tab has a meaningful title.
 * Keys resolve through the i18n catalog; the layout appends the brand suffix.
 */
export function routeTitleKey(route: Route): string {
  return `title.${route.name}`;
}

/**
 * The event an `#/e/<naddr>` route belongs to, or undefined for non-event
 * routes (home, login, settings, key-backup, DM, …). The theme injector keys
 * off this: a 31609 style element exists ONLY while this returns an naddr, and
 * a change of naddr swaps the theme so a second event's CSS never bleeds in.
 */
export function eventNaddr(route: Route): string | undefined {
  switch (route.name) {
    case "event":
    case "join":
    case "record":
    case "attendees":
    case "attendee":
    case "matches":
    case "chat":
    case "talks":
    case "talk":
    case "myProfile":
    case "admin":
    case "posts":
    case "post":
    case "eventMore":
      return route.naddr;
    default:
      return undefined;
  }
}
