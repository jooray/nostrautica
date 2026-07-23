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
import { relayHealth, type RelayHealth } from "$lib/nostr/ndk.js";
import { outbox } from "./outbox.svelte.js";

export type CoordinatorHealth = "unknown" | "ok" | "stale" | "none";

export interface HealthSnapshot {
  internet: boolean;
  /**
   * Relay-transport health (item 5). NOT a boolean any more: a plain
   * "connected? yes/no" flag can't tell "we haven't tried to reach a relay yet"
   * (logged-out home) apart from "we tried and it's blocked" (conference WiFi),
   * and treating the former as blocked false-positived the banner on a fresh
   * logged-out visit with zero connection attempts on the wire.
   */
  relay: RelayHealth;
  outboxPending: number;
  coordinator: CoordinatorHealth;
}

export type OverallHealth = "offline" | "relay-blocked" | "connecting" | "syncing" | "online";

/**
 * Reduce the signals to one headline state:
 *   - offline:        the browser itself reports no internet
 *   - connecting:     no relay open yet, but no attempt has FAILED — either
 *                     nothing has been tried (idle) or an attempt is in flight.
 *                     Renders NO banner: we have no evidence anything is wrong.
 *   - relay-blocked:  a real connect attempt returned with zero relays open
 *                     (the WiFi lie) — internet says yes but the transport is dead.
 *   - syncing:        connected but the outbox still holds queued events
 *   - online:         connected, relay up, nothing queued
 */
export function overallHealth(s: HealthSnapshot): OverallHealth {
  if (!s.internet) return "offline";
  if (s.relay === "connected") return s.outboxPending > 0 ? "syncing" : "online";
  // Only a genuinely FAILED attempt is "blocked"; idle/connecting stay quiet so a
  // page that simply hasn't reached for a relay yet never accuses the network.
  if (s.relay === "failed") return "relay-blocked";
  return "connecting";
}

const RELAY_POLL_MS = 5_000;

class Connectivity {
  internet = $state(true);
  relay = $state<RelayHealth>("idle");
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
    });
    this.pollRelays();
    this.timer = setInterval(() => this.pollRelays(), RELAY_POLL_MS);
  }

  private pollRelays(): void {
    // relayHealth() is the source of truth: idle (never attempted) vs connecting
    // vs connected vs failed — the banner only fires on "failed" (see overallHealth).
    this.relay = relayHealth();
  }

  setCoordinatorHealth(h: CoordinatorHealth): void {
    this.coordinator = h;
  }

  get snapshot(): HealthSnapshot {
    return {
      internet: this.internet,
      relay: this.relay,
      outboxPending: outbox.pending,
      coordinator: this.coordinator,
    };
  }

  get overall(): OverallHealth {
    return overallHealth(this.snapshot);
  }
}

export const connectivity = new Connectivity();
