/**
 * Service-worker controller latch (App-1). Decides, for each `controllerchange`
 * event, whether it represents a real update that should reload the tab — as
 * opposed to the ONE benign controllerchange that fires when a first-ever install
 * claims a previously-uncontrolled page.
 *
 * The old code captured `hadController` once at registration. A tab that
 * first-installed the worker had it `false` forever, so it treated EVERY later
 * controllerchange — including genuine second/third deploys in that same tab —
 * as "the initial install" and never reloaded. This latch instead consumes only
 * the first acquisition, so exactly the initial claim is skipped and every
 * subsequent update reloads.
 *
 * Pure and side-effect-free so the branching is unit-testable without a real
 * service worker (pwa.ts wires it to the live `controllerchange` event).
 */
export class ControllerLatch {
  private reloaded = false;
  private awaitingInitialClaim: boolean;

  /** @param alreadyControlled `!!navigator.serviceWorker.controller` at startup. */
  constructor(alreadyControlled: boolean) {
    // If the page is already controlled there is no initial claim to wait for —
    // any controllerchange from here is a real update.
    this.awaitingInitialClaim = !alreadyControlled;
  }

  /** True if this controllerchange should reload the tab. Call once per event. */
  shouldReload(): boolean {
    if (this.reloaded) return false;
    if (this.awaitingInitialClaim) {
      this.awaitingInitialClaim = false; // consume the first-install claim
      return false;
    }
    this.reloaded = true;
    return true;
  }
}
