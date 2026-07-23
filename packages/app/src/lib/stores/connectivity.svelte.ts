/**
 * Multi-signal connectivity health (audit §7.4.6). `navigator.onLine` alone is a
 * liar on conference Wi-Fi — it reports "online" while a captive portal or
 * firewall silently blocks WSS, so the app looked connected while nothing
 * synced. This store separates four independent signals so the UI can tell the
 * user which layer is actually broken:
 *
 *   - internet:    navigator.onLine (the browser's own guess)
 *   - relay:       at least one relay socket is connected (the real transport)
 *   - outbox:      how many events are waiting in the durable publish queue
 *   - coordinator: reachability of the current event's coordinator, when known
 *
 * The pure `overallHealth` classifier is unit-tested; the class wires the live
 * signals (online/offline events, a relay-count poll, the outbox count).
 */
import { connectedRelayCount } from "$lib/nostr/ndk.js";
import { outbox } from "./outbox.svelte.js";

export type CoordinatorHealth = "unknown" | "ok" | "stale" | "none";

export interface HealthSnapshot {
  internet: boolean;
  relayConnected: boolean;
  outboxPending: number;
  coordinator: CoordinatorHealth;
}

export type OverallHealth = "offline" | "relay-blocked" | "syncing" | "online";

/**
 * Reduce the four signals to one headline state:
 *   - offline:        the browser itself reports no internet
 *   - relay-blocked:  internet says yes but no relay connected (the WiFi lie)
 *   - syncing:        connected but the outbox still holds queued events
 *   - online:         connected, relay up, nothing queued
 */
export function overallHealth(s: HealthSnapshot): OverallHealth {
  if (!s.internet) return "offline";
  if (!s.relayConnected) return "relay-blocked";
  if (s.outboxPending > 0) return "syncing";
  return "online";
}

const RELAY_POLL_MS = 5_000;

class Connectivity {
  internet = $state(true);
  relayConnected = $state(false);
  /** Set by event-scoped pages that know their coordinator's last-seen health. */
  coordinator = $state<CoordinatorHealth>("unknown");
  private started = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  init(): void {
    if (this.started || typeof navigator === "undefined") return;
    this.started = true;
    this.internet = navigator.onLine;
    outbox.init();
    window.addEventListener("online", () => {
      this.internet = true;
      this.pollRelays();
    });
    window.addEventListener("offline", () => {
      this.internet = false;
      this.relayConnected = false;
    });
    this.pollRelays();
    this.timer = setInterval(() => this.pollRelays(), RELAY_POLL_MS);
  }

  private pollRelays(): void {
    this.relayConnected = connectedRelayCount() > 0;
  }

  setCoordinatorHealth(h: CoordinatorHealth): void {
    this.coordinator = h;
  }

  get snapshot(): HealthSnapshot {
    return {
      internet: this.internet,
      relayConnected: this.relayConnected,
      outboxPending: outbox.pending,
      coordinator: this.coordinator,
    };
  }

  get overall(): OverallHealth {
    return overallHealth(this.snapshot);
  }
}

export const connectivity = new Connectivity();
