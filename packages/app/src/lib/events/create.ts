/**
 * Create-event flow (spec §8). The organizer client mints the event's two
 * keypairs (E_id, E_inbox) and ECK v1, publishes the public event + config
 * signed by E_id, and self-encrypts a key backup. No coordinator needed yet.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import {
  KIND_PROFILE,
  KIND_CALENDAR_EVENT,
  KIND_APP_DATA,
  generateEck,
  bytesToBase64,
  bytesToHex,
  makeCoordinate,
  coordinateToNaddr,
  buildEventConfig,
  blindedD,
  type Approval,
  type EventConfig,
  type MatchVisibility,
  type TalksMode,
  type ChatBackend,
  type EventKeysBackup,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { publishOrQueue, toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { DEFAULT_RELAYS, chatInteropRelays } from "$lib/nostr/relays.js";
import { saveEventKeys } from "./keystore.js";
import type { EventContext } from "./event-context.js";
import { generateInvites, approveAttendee } from "./organizer.js";
import { sendJoinRequest } from "./join.js";
import { fetchProfiles } from "./social.js";

export interface CreateEventInput {
  title: string;
  summary: string;
  start: number; // unix seconds
  end?: number;
  location?: string;
  icon?: string; // small event logo/avatar (kind-0 picture) — optional
  banner?: string; // wide event banner (kind-0 banner + 31923 image) — optional
  hashtags?: string[];
  // config
  maxVideoSec: number;
  maxTalkSec: number;
  matching: "on" | "off";
  matchVisibility: MatchVisibility;
  approval: Approval;
  nostrContext: number;
  lang?: string; // ISO 639-1 event language; default "en"
  talks?: TalksMode; // prerecorded-talks journey (spec F2); default "off"
  chat?: ChatBackend[]; // group-chat backends (Marmot); default [] (chat off)
  relays?: string[];
  blossom?: string[];
}

export interface CreatedEvent {
  coordinate: string;
  naddr: string;
  eidPubkey: string;
  inboxPubkey: string;
  /** The parsed config as published — lets callers act on the event (e.g.
   *  organizer self-enrollment) without a relay round-trip. */
  config: EventConfig;
  /** Aggregate publication outcome across the four create events (R9): `queued`
   *  if any only reached the durable outbox (venue Wi-Fi with WSS blocked), so
   *  the UI never tells the organizer the event is live when it isn't. */
  outcome: PublishOutcome;
}

/** Cap on the number of NIP-52 `D` day tags emitted (audit P8). 60 days is a
 *  defensible ceiling for a single meetup/conference and bounds the tag count on
 *  an absurd or misconfigured start..end range. Documented for the spec agent. */
export const MAX_DAY_TAGS = 60;

/**
 * NIP-52 uppercase `D` day-index tags (audit P8 / R5): one tag per UTC calendar
 * day the event spans, so strict or date-indexed calendar clients can discover
 * the event on each of its days.
 *
 * The value is the DECIMAL day-granularity Unix timestamp — `String(Math.floor(
 * unixSeconds / 86400))`, e.g. `"20658"` — as current NIP-52 requires, NOT an
 * ISO `YYYY-MM-DD` string (the earlier P8 remediation emitted ISO, which strict
 * clients reject / can't index; R5).
 *
 * The event covers the half-open instant range `[start, end)`, so `end` is
 * EXCLUSIVE: an event ending exactly at a UTC midnight does not "occur" on the
 * following day and gets no tag for it. The covered days are therefore
 * `floor(start/86400) .. floor((end - 1)/86400)`. `end` absent or at/before
 * `start` yields a single tag for the start day. The count is capped at
 * {@link MAX_DAY_TAGS}. Times are unix SECONDS.
 */
export function dayIndexTags(start: number, end?: number): string[][] {
  const SEC_PER_DAY = 86400;
  const startDay = Math.floor(start / SEC_PER_DAY);
  // Half-open [start, end): the last covered day is the one containing the last
  // instant strictly before `end`. An `end` on a day boundary (midnight) thus
  // excludes that boundary day. `end <= start` (or absent) → single start day.
  const endDay =
    end !== undefined && end > start
      ? Math.max(startDay, Math.floor((end - 1) / SEC_PER_DAY))
      : startDay;
  const tags: string[][] = [];
  for (let day = startDay; day <= endDay && tags.length < MAX_DAY_TAGS; day++) {
    tags.push(["D", String(day)]);
  }
  return tags;
}

function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rand = bytesToHex(crypto.getRandomValues(new Uint8Array(4)));
  return `${base || "event"}-${rand}`;
}

export async function createEvent(
  organizer: AppSigner,
  input: CreateEventInput,
  blindingKey: Uint8Array,
): Promise<CreatedEvent> {
  const eidSk = generateSecretKey();
  const einboxSk = generateSecretKey();
  const eidPubkey = getPublicKey(eidSk);
  const inboxPubkey = getPublicKey(einboxSk);
  const eck = generateEck();
  const d = slug(input.title);
  const coordinate = makeCoordinate(eidPubkey, d);
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  // Marmot chat groups route messages only to the relays baked into the group at
  // creation (§ MLS routing component, not re-derived from config later), so a
  // chat-enabled event must name the Whitenoise client's relays up front or
  // Whitenoise attendees never see the group's traffic (prod report 2026-07-20).
  // They go in the SEPARATE `chat_relay` set, not in `relays`: they refuse every
  // kind this app publishes except the chat ones, so unioning them in (as this
  // did until 2026-07-28) made both of them reject the 31600/31923/kind-0 this
  // very function publishes below, and put two dead-for-reading relay hints into
  // the event's naddr.
  const chatRelays = input.chat?.length ? chatInteropRelays(relays) : [];

  // 1. kind 0 for E_id — the event's public profile (name/logo).
  const kind0 = finalizeEvent(
    {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({
        name: input.title,
        about: input.summary,
        ...(input.icon ? { picture: input.icon } : {}),
        ...(input.banner ? { banner: input.banner } : {}),
      }),
    },
    eidSk,
  );

  // 2. kind 31923 — the NIP-52 event itself (interoperates with any NIP-52 client).
  const eventTags: string[][] = [
    ["d", d],
    ["title", input.title],
    ["start", String(input.start)],
  ];
  if (input.end) eventTags.push(["end", String(input.end)]);
  // NIP-52 `D` day-index tags — one per UTC day the event covers (audit P8).
  for (const t of dayIndexTags(input.start, input.end)) eventTags.push(t);
  if (input.summary) eventTags.push(["summary", input.summary]);
  if (input.banner) eventTags.push(["image", input.banner]);
  if (input.location) eventTags.push(["location", input.location]);
  for (const t of input.hashtags ?? []) eventTags.push(["t", t]);
  const event31923 = finalizeEvent(
    {
      kind: KIND_CALENDAR_EVENT,
      created_at: Math.floor(Date.now() / 1000),
      tags: eventTags,
      content: input.summary,
    },
    eidSk,
  );

  // 3. kind 31600 — the networking config (signed by E_id).
  const config: EventConfig = {
    d,
    eidPubkey,
    inbox: inboxPubkey,
    relays,
    chatRelays,
    blossom: input.blossom ?? [],
    maxVideoSec: input.maxVideoSec,
    maxTalkSec: input.maxTalkSec,
    matching: input.matching,
    matchVisibility: input.matchVisibility,
    approval: input.approval,
    eck: 1,
    nostrContext: input.nostrContext,
    lang: input.lang ?? "en",
    talks: input.talks ?? "off",
    chat: input.chat ?? [],
  };
  const cfg = buildEventConfig(config);
  const event31600 = finalizeEvent(
    {
      kind: cfg.kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: cfg.tags,
      content: cfg.content,
    },
    eidSk,
  );

  // 4. Self-encrypted organizer key backup (30078 eventkeys, spec §7.3).
  const backup: EventKeysBackup = {
    v: 2,
    a: coordinate, // so a fresh device can restore into the coordinate-keyed keystore
    eid_nsec: bytesToHex(eidSk),
    einbox_nsec: bytesToHex(einboxSk),
    eck: [{ id: 1, key: bytesToBase64(eck) }],
  };
  const ownPubkey = await organizer.getPublicKey();
  const backupContent = await organizer.nip44Encrypt(ownPubkey, JSON.stringify(backup));
  const backupD = `nostrautica:eventkeys:${blindedD(blindingKey, coordinate, ownPubkey)}`;
  const event30078 = await organizer.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", backupD]],
    content: backupContent,
  });

  // Publish public events to the event relays; backup to the user's relays.
  // These are brand-new keys/coordinate with no prior event to supersede, so
  // created_at = now is correct (no monotonic read needed); we still aggregate
  // each result honestly so the UI can distinguish published from queued (R9).
  const results = await Promise.all([
    publishOrQueue(kind0, relays),
    publishOrQueue(event31923, relays),
    publishOrQueue(event31600, relays),
    publishOrQueue(event30078),
  ]);
  const outcome = toOutcome(results.every(Boolean));

  // Persist keys locally (organizer role) for immediate admin use + offline.
  await saveEventKeys({
    coordinate,
    role: "organizer",
    eck: [{ id: 1, key: bytesToBase64(eck) }],
    eidNsecHex: bytesToHex(eidSk),
    einboxNsecHex: bytesToHex(einboxSk),
  });

  return {
    coordinate,
    naddr: coordinateToNaddr(coordinate, relays),
    eidPubkey,
    inboxPubkey,
    config,
    outcome,
  };
}

/**
 * A local EventContext for the event just created — everything is known
 * client-side, so post-create actions never race the relay round-trip.
 */
export function createdEventContext(created: CreatedEvent, input: CreateEventInput): EventContext {
  return {
    naddr: created.naddr,
    coordinate: created.coordinate,
    config: created.config,
    title: input.title,
    summary: input.summary,
    start: input.start,
    end: input.end,
    icon: input.icon,
    banner: input.banner,
    location: input.location,
    hashtags: input.hashtags ?? [],
  };
}

/**
 * Enroll the organizer as a regular participant of their own event (the
 * create-form checkbox). Two halves, both keyed to the organizer's PERSONAL
 * pubkey (never E_id):
 *
 * 1. A real invite-backed 21600 join request to E_inbox. This is what makes the
 *    enrollment durable across a LATER coordinator attach: a fresh install
 *    backfills E_inbox history, finds the request, and the invite proof
 *    auto-approves it — the organizer never lands in their own pending queue,
 *    and the coordinator's roster/directory (which replace E_id's once
 *    attached) include them.
 * 2. An immediate client-side self-approval (grant + directory entry + roster,
 *    all signed by E_id) so the first attendee sees the organizer right away,
 *    before any coordinator exists. Roster role stays "organizer" — the roster
 *    schema models participant-and-admin natively.
 *
 * The keystore is untouched: the organizer record already exists and an
 * incoming ECK grant never downgrades its role.
 */
export async function enrollOrganizerAsParticipant(
  organizer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
  appBaseUrl: string,
): Promise<void> {
  const pubkey = await organizer.getPublicKey();
  const me = await fetchProfiles([pubkey]).catch(() => new Map());
  const name = me.get(pubkey)?.name ?? "";
  const profile = {
    about: me.get(pubkey)?.about ?? "",
    skills: [],
    looking_for: "",
    links: [],
  };

  const [invite] = await generateInvites(organizer, ctx, 1, appBaseUrl, "organizer-self");
  await sendJoinRequest(
    organizer,
    ctx,
    { name, profile, inviteNsec: invite?.nsec },
    blindingKey,
  );
  await approveAttendee(
    organizer,
    ctx,
    {
      attendeePubkey: pubkey,
      name,
      message: "",
      rsvpPublic: false,
      profile,
      rumorCreatedAt: Math.floor(Date.now() / 1000),
    },
    "organizer",
  );
}
