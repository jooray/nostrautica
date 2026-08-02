/**
 * Join flow (spec §8). The attendee sends a gift-wrapped Join Request (21600) to
 * E_inbox, optionally with a Profile Submission (21601), and saves a self-copy
 * (31602) so their own submission is queryable (gift wraps aren't — they carry
 * random one-time authors).
 *
 * With an invite code, the request carries an invite proof binding the code to
 * the attendee's pubkey (spec §6.5) — auto-approval handled by the coordinator.
 * Public RSVP (31925) is opt-in (default private).
 */
import {
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_MY_PROFILE,
  KIND_CALENDAR_RSVP,
  makeInviteProof,
  blindedD,
  MAX_SUBMISSION_MEDIA,
  MAX_MESSAGE,
  MAX_NAME,
  type AttendeeProfile,
  type MediaDescriptor,
} from "@nostrautica/protocol";
import { normalizeAuthoredProfile } from "./authored-profile.js";
import { decode } from "nostr-tools/nip19";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { signerWrap } from "./giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { loadSelfCopy, cacheSelfCopy } from "$lib/media/submit.js";
import { t } from "$lib/i18n/i18n.svelte.js";

export interface JoinInput {
  name: string;
  message?: string;
  rsvpPublic?: boolean;
  profile?: AttendeeProfile;
  /** Media reused from the library at join time (UI-SUGGESTIONS #11) — rides the
   *  same 21601 + 31602 as the profile so there's no second racing submission. */
  media?: MediaDescriptor[];
  inviteNsec?: string; // from #/e/:naddr/join?code=<invite-nsec>
}

function inviteSkFromCode(code: string): Uint8Array {
  const decoded = decode(code.trim());
  if (decoded.type !== "nsec") throw new Error(t("error.inviteCode"));
  return decoded.data;
}

export async function sendJoinRequest(
  signer: AppSigner,
  ctx: EventContext,
  input: JoinInput,
  blindingKey: Uint8Array,
): Promise<boolean> {
  const attendeePubkey = await signer.getPublicKey();
  const inboxPubkey = ctx.config.inbox;
  const relays = ctx.config.relays;

  // Build the invite proof tag if a code was supplied (spec §6.5).
  const joinTags: string[][] = [["a", ctx.coordinate]];
  if (input.inviteNsec) {
    const proof = makeInviteProof(
      inviteSkFromCode(input.inviteNsec),
      ctx.coordinate,
      attendeePubkey,
    );
    joinTags.push(["invite", proof.invitePubkey, proof.sig]);
  }

  // Bound what the join carries to what joinRequestContentSchema accepts. The
  // penalty for overshooting is not a truncated name — the coordinator treats a
  // ZodError as permanently unprocessable and drops the JOIN itself, so the
  // person never appears in the queue at all. `name` reaching MAX_NAME is
  // implausible from the form, but it is prefilled from a kind-0 nobody here
  // controls, which is exactly the shape of input worth bounding.
  const joinContent = {
    v: 2,
    name: input.name.slice(0, MAX_NAME),
    message: (input.message ?? "").slice(0, MAX_MESSAGE),
    rsvp_public: !!input.rsvpPublic,
  };
  // Same reasoning for the profile: `about` is copied verbatim from the joiner's
  // kind-0 bio, and one over MAX_ABOUT would take the whole submission with it.
  const profile = input.profile ? normalizeAuthoredProfile(input.profile).profile : undefined;

  // Application revision (NIP §3.3), REQUIRED on the 21601 submission — the
  // coordinator orders profile submissions by (rev, created_at, id) and drops any
  // rumor missing it as permanently unprocessable ("invalid_type … path rev").
  // join.ts omitted it, so every attendee's join-time skills/looking_for silently
  // never reached matching (prod incident 2026-07-23). It shares the SAME
  // monotonic per-(coordinate) counter as later Record/profile edits: the counter
  // lives on the 31602 self-copy, so a post-join edit reads this value back
  // (loadSelfCopy) and bumps past it, cleanly superseding the join submission. A
  // first join is rev 0; the self-copy written below carries it so the next edit
  // bumps from it.
  const prevSelf = await loadSelfCopy(signer, ctx, blindingKey).catch(() => undefined);
  const rev = (prevSelf?.rev ?? -1) + 1;

  const wraps: Promise<unknown>[] = [
    signerWrap(signer, inboxPubkey, {
      kind: KIND_JOIN_REQUEST,
      content: joinContent,
      tags: joinTags,
    }).then((w) => publishOrQueue(w as any, relays)),
  ];

  // Optional profile submission (21601) — profile text + any media reused at join.
  if (profile) {
    const submission = {
      v: 2,
      rev,
      profile,
      // v2 (NIP §8): the 21601 submission caps media at MAX_SUBMISSION_MEDIA (4);
      // the 31602 self-copy below keeps the full set (MAX_MEDIA).
      media: (input.media ?? []).slice(0, MAX_SUBMISSION_MEDIA),
    };
    wraps.push(
      signerWrap(signer, inboxPubkey, {
        kind: KIND_PROFILE_SUBMISSION,
        content: submission,
        tags: [["a", ctx.coordinate]],
      }).then((w) => publishOrQueue(w as any, relays)),
    );
  }

  // Self-copy (31602) — the attendee's own queryable record, blinded d over the
  // self-conversation key (spec §6.6, §7.3).
  const selfContent = {
    v: 2,
    a: ctx.coordinate,
    rev,
    profile,
    media: input.media ?? [],
  };
  const selfD = blindedD(blindingKey, ctx.coordinate, attendeePubkey);
  const selfCipher = await signer.nip44Encrypt(attendeePubkey, JSON.stringify(selfContent));
  const selfEvent = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", selfD]],
    content: selfCipher,
  });
  wraps.push(publishOrQueue(selfEvent));
  // Seed the local copy from the very first 31602 (both outcomes above are
  // durable — relay or outbox). The next thing this attendee does is usually
  // "record your intro" on the same venue Wi-Fi that just made this publish
  // slow, and that flow builds its submission out of the self-copy: with no
  // local copy to fall back on, an empty relay read there reads as "no profile"
  // and blanks the fields typed on this very screen.
  cacheSelfCopy(
    ctx.coordinate,
    { profile, media: input.media ?? [], rev },
    selfEvent.created_at,
  );

  // Opt-in public RSVP (31925) — a standard, discoverable calendar RSVP.
  if (input.rsvpPublic) {
    const rsvp = await signer.signEvent({
      kind: KIND_CALENDAR_RSVP,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", ctx.coordinate],
        ["d", `${ctx.coordinate}:${attendeePubkey}`],
        ["status", "accepted"],
      ],
      content: "",
    });
    wraps.push(publishOrQueue(rsvp, relays));
  }

  const published = await Promise.all(wraps);
  // True when every publish went out immediately; false when anything landed in
  // the durable offline queue (audit UX-15) so the UI can say "will send when
  // you're back online" instead of implying the organizer already has it.
  return published.every(Boolean);
}
