/**
 * Connectivity store (spec §10.4). Drives the offline banner; the publish queue
 * flushes independently on the `online` event.
 */
class Online {
  isOnline = $state(true);

  init(): void {
    if (typeof navigator === "undefined") return;
    this.isOnline = navigator.onLine;
    window.addEventListener("online", () => (this.isOnline = true));
    window.addEventListener("offline", () => (this.isOnline = false));
  }
}

export const online = new Online();
