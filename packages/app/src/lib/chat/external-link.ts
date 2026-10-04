/**
 * "Also chat from White Noise" (NIP §10.5): link an external Marmot client's
 * identity to this account for one event, so the coordinator adds it to the
 * event's group.
 *
 * Two 21607 rumors, both sealed by the ACCOUNT key like every attestation:
 *  - `op:"link"` names the external key. When it is the account's own key the
 *    seal is the proof and the coordinator links it straight away; otherwise it
 *    invites the key into a throwaway group and posts a one-time code there.
 *  - `op:"link_confirm"` sends that code back once the user has read it in the
 *    external client.
 *
 * The coordinator answers through 21606 notices on stage {@link CHAT_LINK_STAGE}
 * (recorded by the grant scan into `ownStatusStore`), and a successful link shows
 * up as an `external` entry in the roster's `chat_keys`. This module holds the
 * pure pieces (input parsing, notice → message mapping, the persisted "waiting
 * for a code" marker) so they can be tested without a page.
 */
import { decode } from "nostr-tools/nip19";
import type { CoordinatorStatusContent, RosterContent } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import type { MessageKey } from "$lib/i18n/messages.js";
import { sendChatKeyAttestation } from "./attest.js";

/** The 21606 stage the coordinator files link outcomes under. */
export const CHAT_LINK_STAGE = "chat_link";
/** Label the linked key gets in the device list. */
export const EXTERNAL_LINK_LABEL = "White Noise";
/** Matches the coordinator's code lifetime: past this a "waiting" marker is stale. */
export const PENDING_LINK_TTL_MS = 30 * 60_000;

/**
 * An npub, nprofile or 64-char hex pubkey (optionally `nostr:`-prefixed, as a
 * pasted share link often is) → lowercase hex. `null` for anything else,
 * including an nsec: the one thing this field must never quietly accept.
 */
export function parseExternalChatPubkey(input: string): string | null {
  const s = input.trim().replace(/^nostr:/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!/^(npub|nprofile)1/i.test(s)) return null;
  try {
    const d = decode(s.toLowerCase());
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    /* fall through */
  }
  return null;
}

/** Ask the coordinator to link `chatPubkey` (NIP §10.5). Resolves `true` once on a relay. */
export function sendChatLinkRequest(
  signer: AppSigner,
  ctx: EventContext,
  chatPubkey: string,
  label = EXTERNAL_LINK_LABEL,
): Promise<boolean> {
  return sendChatKeyAttestation(signer, ctx, { op: "link", chatPubkey, label });
}

/** Send the code read in the external client back to the coordinator. */
export function sendChatLinkConfirm(
  signer: AppSigner,
  ctx: EventContext,
  chatPubkey: string,
  code: string,
): Promise<boolean> {
  return sendChatKeyAttestation(signer, ctx, { op: "link_confirm", chatPubkey, code: code.trim() });
}

/** Whether the roster already lists `chatPubkey` as one of `account`'s chat keys. */
export function isLinkedInRoster(
  roster: RosterContent | undefined,
  account: string,
  chatPubkey: string,
): boolean {
  const entry = roster?.attendees.find((a) => a.pubkey === account);
  return !!entry?.chat_keys?.some((k) => k.pubkey === chatPubkey);
}

/**
 * The coordinator's latest word on a link started at `sinceSec` (unix seconds):
 * the newest `chat_link` notice no older than that, minus a little slack for a
 * device clock running ahead of the coordinator's. Older notices belong to an
 * earlier attempt and must not greet a fresh one with its failure.
 *
 * `afterAt` is the newest notice already on hand when the user acted: anything
 * at or before it answered a previous action, however recent (the slack alone
 * would let a refusal from 30 s ago kill the attempt the user just started).
 */
export function latestLinkNotice(
  statuses: CoordinatorStatusContent[],
  sinceSec: number,
  afterAt = Number.NEGATIVE_INFINITY,
  slackSec = 120,
): CoordinatorStatusContent | undefined {
  return statuses
    .filter((s) => s.stage === CHAT_LINK_STAGE && s.at >= sinceSec - slackSec && s.at > afterAt)
    .sort((a, b) => b.at - a.at)[0];
}

/** The `at` of the newest link notice on hand (the `afterAt` baseline for an action). */
export function newestLinkNoticeAt(statuses: CoordinatorStatusContent[]): number {
  return statuses.filter((s) => s.stage === CHAT_LINK_STAGE).reduce((m, s) => Math.max(m, s.at), Number.NEGATIVE_INFINITY);
}

const REFUSALS: Record<string, MessageKey> = {
  chat_link_unavailable: "chat.wn.refused.unavailable",
  chat_link_rate_limited: "chat.wn.refused.rateLimited",
  chat_link_no_key_package: "chat.wn.refused.noKeyPackage",
  chat_link_failed: "chat.wn.refused.failed",
  chat_link_no_pending: "chat.wn.refused.noPending",
  chat_link_expired: "chat.wn.refused.expired",
  chat_link_code_wrong: "chat.wn.refused.codeWrong",
  chat_link_too_many_attempts: "chat.wn.refused.tooMany",
  chat_device_cap_reached: "chat.wn.refused.deviceCap",
  chat_key_bound_to_other_account: "chat.wn.refused.boundElsewhere",
  chat_key_package_ineligible: "chat.wn.refused.keyPackage",
};

/** Message for a refusal category; an unknown one (a newer coordinator) gets a generic line. */
export function linkRefusalMessage(category: string | undefined): MessageKey {
  return REFUSALS[category ?? ""] ?? "chat.wn.refused.other";
}

/**
 * Refusals after which the pending code is gone for good: the user has to start
 * over rather than retype. A wrong code is the one they can simply fix.
 */
export function refusalEndsLink(category: string | undefined): boolean {
  return category !== "chat_link_code_wrong";
}

// ── the "waiting for a code" marker ───────────────────────────────────────────
// Survives a reload (the user switches to White Noise and back, and a mobile
// browser may well have discarded the tab meanwhile). Per-viewer convenience
// only, so localStorage — every access guarded, the card works without it.

export interface PendingLink {
  chatPubkey: string;
  /** unix seconds the request was sent. */
  startedAt: number;
}

function pendingKey(account: string, coordinate: string): string {
  return `nostrautica:chat-link:${account}:${coordinate}`;
}

export function loadPendingLink(account: string, coordinate: string, nowMs = Date.now()): PendingLink | undefined {
  try {
    const raw = localStorage.getItem(pendingKey(account, coordinate));
    if (!raw) return undefined;
    const p = JSON.parse(raw) as Partial<PendingLink>;
    if (typeof p.chatPubkey !== "string" || !/^[0-9a-f]{64}$/.test(p.chatPubkey)) return undefined;
    if (typeof p.startedAt !== "number" || nowMs - p.startedAt * 1000 > PENDING_LINK_TTL_MS) return undefined;
    return { chatPubkey: p.chatPubkey, startedAt: p.startedAt };
  } catch {
    return undefined;
  }
}

export function savePendingLink(account: string, coordinate: string, link: PendingLink): void {
  try {
    localStorage.setItem(pendingKey(account, coordinate), JSON.stringify(link));
  } catch {
    /* private mode / storage blocked: the card simply forgets on reload */
  }
}

export function clearPendingLink(account: string, coordinate: string): void {
  try {
    localStorage.removeItem(pendingKey(account, coordinate));
  } catch {
    /* ignore */
  }
}
