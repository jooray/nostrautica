/**
 * Event Networking Config (kind 31600, spec §7.1). Unlike the JSON payloads, the
 * config lives entirely in tags on a public event signed by `E_id`. This module
 * builds and parses those tags into a typed object.
 */
import { KIND_EVENT_CONFIG } from "./kinds.js";
import { makeCoordinate } from "./coordinate.js";

export type Approval = "manual" | "invite" | "manual+invite";
export type MatchVisibility = "pair" | "event";

export interface EventConfig {
  d: string;
  eidPubkey: string; // author of the config (E_id)
  inbox: string; // E_inbox pubkey hex
  coordinator?: string; // coordinator pubkey hex (absent = no coordinator)
  relays: string[];
  blossom: string[];
  maxVideoSec: number;
  maxTalkSec: number;
  matching: "on" | "off";
  matchVisibility: MatchVisibility;
  approval: Approval;
  eck: number; // current ECK version
  nostrContext: number; // N public events per attendee to summarize; 0 = off
  lang: string; // ISO 639-1 event language (attendee UI + AI output); default "en"
}

export interface EventConfigTags {
  kind: number;
  tags: string[][];
  content: string;
}

/** Build the tag array for a kind 31600 event. */
export function buildEventConfig(cfg: EventConfig): EventConfigTags {
  const coordinate = makeCoordinate(cfg.eidPubkey, cfg.d);
  const tags: string[][] = [
    ["d", cfg.d],
    ["a", coordinate],
    ["v", "1"],
    ["inbox", cfg.inbox],
  ];
  if (cfg.coordinator) tags.push(["coordinator", cfg.coordinator]);
  for (const r of cfg.relays) tags.push(["relay", r]);
  for (const b of cfg.blossom) tags.push(["blossom", b]);
  tags.push(["max_video_sec", String(cfg.maxVideoSec)]);
  tags.push(["max_talk_sec", String(cfg.maxTalkSec)]);
  tags.push(["matching", cfg.matching]);
  tags.push(["match_visibility", cfg.matchVisibility]);
  tags.push(["approval", cfg.approval]);
  tags.push(["eck", String(cfg.eck)]);
  tags.push(["nostr_context", String(cfg.nostrContext)]);
  // Language is a single lowercased ISO 639-1 code; "en" is the implicit default,
  // so only emit the tag when it differs (keeps existing en events byte-identical).
  const lang = normalizeLang(cfg.lang);
  if (lang !== "en") tags.push(["lang", lang]);
  return { kind: KIND_EVENT_CONFIG, tags, content: "" };
}

/** Normalize a language value to a bare lowercased ISO 639-1 base code. */
function normalizeLang(lang: string | undefined): string {
  const base = (lang ?? "en").trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2}$/.test(base ?? "") ? base! : "en";
}

function first(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}
function all(tags: string[][], name: string): string[] {
  return tags.filter((t) => t[0] === name).map((t) => t[1]!).filter(Boolean);
}

/** Parse a kind 31600 event (its author pubkey + tags) into an EventConfig. */
export function parseEventConfig(
  eidPubkey: string,
  tags: string[][],
): EventConfig {
  const d = first(tags, "d");
  const inbox = first(tags, "inbox");
  if (!d || !inbox) throw new Error("31600 config missing d or inbox");
  const approval = (first(tags, "approval") ?? "manual") as Approval;
  const matchVisibility = (first(tags, "match_visibility") ??
    "pair") as MatchVisibility;
  return {
    d,
    eidPubkey,
    inbox,
    coordinator: first(tags, "coordinator"),
    relays: all(tags, "relay"),
    blossom: all(tags, "blossom"),
    maxVideoSec: Number(first(tags, "max_video_sec") ?? "90"),
    maxTalkSec: Number(first(tags, "max_talk_sec") ?? "900"),
    matching: (first(tags, "matching") ?? "off") === "on" ? "on" : "off",
    matchVisibility,
    approval,
    eck: Number(first(tags, "eck") ?? "1"),
    nostrContext: Number(first(tags, "nostr_context") ?? "0"),
    lang: normalizeLang(first(tags, "lang")),
  };
}

/** The event coordinate for a parsed config. */
export function configCoordinate(cfg: EventConfig): string {
  return makeCoordinate(cfg.eidPubkey, cfg.d);
}
