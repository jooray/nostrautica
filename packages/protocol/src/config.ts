/**
 * Event Networking Config (kind 31600, spec §7.1). Unlike the JSON payloads, the
 * config lives entirely in tags on a public event signed by `E_id`. This module
 * builds and parses those tags into a typed object.
 */
import { KIND_EVENT_CONFIG } from "./kinds.js";
import { makeCoordinate } from "./coordinate.js";

/**
 * Sentinel for "no length cap" on `max_video_sec`/`max_talk_sec` (recorder UI
 * "unlimited" option). Chosen over omitting the tag so an organizer can
 * explicitly *remove* a cap on an event that previously had one (an omitted
 * tag instead falls back to the 90/900 spec default via `intTag`). Existing
 * events with 90/900 keep working unchanged; only an explicit "0" means
 * unlimited.
 */
export const UNLIMITED_SEC = 0;

export type Approval = "manual" | "invite" | "manual+invite";
export type MatchVisibility = "pair" | "event";
/**
 * Prerecorded-talks journey mode (spec F2, audit U11):
 *  - "off" (default, tag OMITTED) — no Talks nav, no talk step; normal event.
 *  - "on" — Talks destination + submission/watch available.
 *  - "prerecord-first" — Talks featured before People (watch ahead, meet at venue).
 */
export type TalksMode = "off" | "on" | "prerecord-first";

/**
 * Per-event group-chat backend (spec MARMOT-GROUP-CHAT §1.3). The only defined
 * value is `"marmot"` (MLS over Nostr); the field is an array for forward-compat
 * so a future backend can be added without a structural change. An empty array =
 * chat disabled (the `chat` tag is omitted entirely, keeping non-chat events
 * byte-identical). `chat=marmot` is only *operative* when the event also has a
 * `coordinator` (the MLS admin bot); parse keeps the value regardless, but the app
 * and coordinator treat a coordinator-less `chat` as absent.
 */
export type ChatBackend = "marmot";
const CHAT_BACKENDS: ChatBackend[] = ["marmot"];

export interface EventConfig {
  d: string;
  eidPubkey: string; // author of the config (E_id)
  inbox: string; // E_inbox pubkey hex
  coordinator?: string; // coordinator pubkey hex (absent = no coordinator)
  relays: string[];
  blossom: string[];
  /** Seconds; 0 means unlimited (no hard cap). Defaults to 90 when the tag is absent. */
  maxVideoSec: number;
  /** Seconds; 0 means unlimited (no hard cap). Defaults to 900 when the tag is absent. */
  maxTalkSec: number;
  matching: "on" | "off";
  matchVisibility: MatchVisibility;
  approval: Approval;
  eck: number; // current ECK version
  nostrContext: number; // N public events per attendee to summarize; 0 = off
  lang: string; // ISO 639-1 event language (attendee UI + AI output); default "en"
  talks: TalksMode; // prerecorded-talks journey (spec F2); default "off" (tag omitted)
  chat: ChatBackend[]; // group-chat backends (Marmot §1.3); default [] (tag omitted)
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
  // Talks mode: "off" is the implicit default, so only emit the tag when talks are
  // enabled — normal (talks-off) events stay byte-identical. Localized here so it
  // composes with the upcoming Marmot `chat` tag (same three edit sites).
  if (cfg.talks && cfg.talks !== "off") tags.push(["talks", cfg.talks]);
  // Chat backends: one ["chat", <backend>] tag per enabled backend, omitted
  // entirely when none — so a chat-off event stays byte-identical. Localized here
  // with `talks` and `lang` (same three edit sites) so a coordinator config-rebuild
  // round-trip never silently drops it (see event-page.ts warning).
  for (const backend of cfg.chat ?? []) {
    if (CHAT_BACKENDS.includes(backend)) tags.push(["chat", backend]);
  }
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

/** Canonical lowercase-hex 32-byte pubkey (every downstream comparison is case-sensitive). */
const HEX32 = /^[0-9a-f]{64}$/;

/**
 * Tag values that parse as URLs of the given protocol, dropping the rest
 * (fail-soft, audit PROTO-5): relays must be wss:// and Blossom servers https://,
 * anything else from a relay is ignored rather than surfaced to the client.
 */
function urlValues(tags: string[][], name: string, protocol: string): string[] {
  return all(tags, name).filter((v) => {
    try {
      return new URL(v).protocol === protocol;
    } catch {
      return false;
    }
  });
}

const APPROVALS: Approval[] = ["manual", "invite", "manual+invite"];
const VISIBILITIES: MatchVisibility[] = ["pair", "event"];
const TALKS_MODES: TalksMode[] = ["off", "on", "prerecord-first"];

/**
 * Parse a positive-integer tag value with a default (Q7). An absent, non-numeric,
 * negative, or non-finite value falls back to `def` rather than yielding NaN —
 * malformed config from a relay must never produce a `Number("x") = NaN` that
 * silently poisons downstream arithmetic.
 */
function intTag(tags: string[][], name: string, def: number): number {
  const raw = first(tags, name);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/**
 * Parse a kind 31600 event (its author pubkey + tags) into an EventConfig.
 *
 * The `d` and `inbox` structural tags are required (throw if missing). Everything
 * else is validated-with-fallback (Q7): an out-of-range enum or non-finite number
 * is clamped to its documented default rather than throwing, because the
 * coordinator parses this from public relay data and a single malformed tag must
 * degrade gracefully (and be surfaced as a health diagnostic) instead of crashing
 * config application.
 */
export function parseEventConfig(
  eidPubkey: string,
  tags: string[][],
): EventConfig {
  const d = first(tags, "d");
  // The inbox/coordinator pubkeys are accepted only in canonical lowercase hex
  // (audit PROTO-5): an invalid inbox is treated as missing (required structural
  // tag → throw, as today), an invalid coordinator is dropped (optional → absent)
  // — the same fail-soft style the parser uses for other bad values.
  const inboxRaw = first(tags, "inbox");
  const inbox = inboxRaw && HEX32.test(inboxRaw) ? inboxRaw : undefined;
  if (!d || !inbox) throw new Error("31600 config missing d or inbox");
  const approvalRaw = first(tags, "approval");
  const approval: Approval = APPROVALS.includes(approvalRaw as Approval)
    ? (approvalRaw as Approval)
    : "manual";
  const visRaw = first(tags, "match_visibility");
  const matchVisibility: MatchVisibility = VISIBILITIES.includes(visRaw as MatchVisibility)
    ? (visRaw as MatchVisibility)
    : "pair";
  // An absent or unrecognized talks tag falls back to "off" (default): a normal
  // event with no talks tag parses exactly as a talks-off event.
  const talksRaw = first(tags, "talks");
  const talks: TalksMode = TALKS_MODES.includes(talksRaw as TalksMode)
    ? (talksRaw as TalksMode)
    : "off";
  // Collect every `chat` tag, keep the known backends (dropping unknown values and
  // duplicates), preserving first-seen order. An absent tag yields [] (chat off).
  const chat: ChatBackend[] = [];
  for (const backend of all(tags, "chat")) {
    if (CHAT_BACKENDS.includes(backend as ChatBackend) && !chat.includes(backend as ChatBackend)) {
      chat.push(backend as ChatBackend);
    }
  }
  const coordinatorRaw = first(tags, "coordinator");
  return {
    d,
    eidPubkey,
    inbox,
    coordinator: coordinatorRaw && HEX32.test(coordinatorRaw) ? coordinatorRaw : undefined,
    relays: urlValues(tags, "relay", "wss:"),
    blossom: urlValues(tags, "blossom", "https:"),
    // 0 is a valid parsed value (UNLIMITED_SEC) — intTag only falls back to the
    // default when the tag is absent/non-numeric/negative, never for 0 itself.
    maxVideoSec: intTag(tags, "max_video_sec", 90),
    maxTalkSec: intTag(tags, "max_talk_sec", 900),
    matching: first(tags, "matching") === "on" ? "on" : "off",
    matchVisibility,
    approval,
    eck: Math.max(1, intTag(tags, "eck", 1)),
    nostrContext: intTag(tags, "nostr_context", 0),
    lang: normalizeLang(first(tags, "lang")),
    talks,
    chat,
  };
}

/** The event coordinate for a parsed config. */
export function configCoordinate(cfg: EventConfig): string {
  return makeCoordinate(cfg.eidPubkey, cfg.d);
}

/**
 * Whether Marmot group chat is *operative* for this event (spec §1.3): the `chat`
 * config must list `"marmot"` AND the event must have a coordinator (the MLS admin
 * bot). A `chat=marmot` config with no coordinator is parsed but treated as absent
 * by both the app and the coordinator.
 */
export function isMarmotChatEnabled(cfg: EventConfig): boolean {
  return !!cfg.coordinator && cfg.chat.includes("marmot");
}
