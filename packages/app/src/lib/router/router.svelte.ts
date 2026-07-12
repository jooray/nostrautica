/**
 * Reactive hash-router store (spec §10.1). Wraps the pure `parseHash` in a rune
 * that tracks `location.hash`; `navigate` updates the hash (which triggers the
 * `hashchange` listener and re-derives the route).
 */
import { parseHash, buildHash, type Route } from "./routes.js";

class Router {
  route = $state<Route>({ name: "home" });

  init(): void {
    if (typeof window === "undefined") return;
    this.sync();
    window.addEventListener("hashchange", () => this.sync());
  }

  private sync(): void {
    this.route = parseHash(window.location.hash);
  }

  /** Navigate to a route (or a raw hash string). */
  go(target: Route | string): void {
    const hash = typeof target === "string" ? target : buildHash(target);
    if (typeof window !== "undefined") window.location.hash = hash;
  }
}

export const router = new Router();
