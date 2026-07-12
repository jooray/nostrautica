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
  | { name: "admin"; naddr: string }
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
        case "admin":
          return { name: "admin", naddr };
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
    case "admin":
      return `#/e/${route.naddr}/admin`;
    case "notFound":
      return route.hash;
  }
}
