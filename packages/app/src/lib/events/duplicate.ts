/**
 * Duplicate-event prefill (spec §13 organizer QoL). Clones an existing event's
 * CONFIG as a starting point for the create form — settings only. It deliberately
 * carries NO identity: no coordinate, no `d`, no E_id/E_inbox keys, no coordinator
 * assignment, and no start/end dates. Create mints fresh keys and a fresh `d` as
 * always, so a duplicate can never collide with or impersonate the original.
 */
import type { EventConfig } from "@nostrautica/protocol";

/** The create-form fields a duplicate pre-fills (a strict subset of the config). */
export interface DuplicatePrefill {
  title: string;
  summary: string;
  iconUrl: string;
  bannerUrl: string;
  talks: "off" | "on" | "prerecord-first";
  matching: "on" | "off";
  matchVisibility: "pair" | "event";
  approval: "manual" | "invite" | "manual+invite";
  lang: string;
  maxVideoSec: number;
  maxTalkSec: number;
  chatEnabled: boolean;
}

/**
 * Build the prefill from an existing event's public surface. `title` becomes
 * "Copy of <title>" so the organizer notices it's a fresh event; dates are left
 * blank on purpose (a clone is a NEW occurrence). Identity fields are never read.
 */
export function buildDuplicatePrefill(input: {
  title: string;
  summary: string;
  icon?: string;
  banner?: string;
  config: EventConfig;
  copyPrefix?: (title: string) => string;
}): DuplicatePrefill {
  const { config } = input;
  const prefixed = (input.copyPrefix ?? ((t) => `Copy of ${t}`))(input.title);
  return {
    title: prefixed,
    summary: input.summary,
    iconUrl: input.icon ?? "",
    bannerUrl: input.banner ?? "",
    talks: config.talks,
    matching: config.matching,
    matchVisibility: config.matchVisibility,
    approval: config.approval,
    lang: config.lang,
    maxVideoSec: config.maxVideoSec,
    maxTalkSec: config.maxTalkSec,
    chatEnabled: config.chat.length > 0,
  };
}
