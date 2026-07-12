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
  type AttendeeProfile,
} from "@nostrautica/protocol";
import { decode } from "nostr-tools/nip19";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { signerWrap } from "./giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

export interface JoinInput {
  name: string;
  message?: string;
  rsvpPublic?: boolean;
  profile?: AttendeeProfile;
  inviteNsec?: string; // from #/e/:naddr/join?code=<invite-nsec>
}

function inviteSkFromCode(code: string): Uint8Array {
  const decoded = decode(code.trim());
  if (decoded.type !== "nsec") throw new Error("Invite code must be an nsec");
  return decoded.data;
}

export async function sendJoinRequest(
  signer: AppSigner,
  ctx: EventContext,
  input: JoinInput,
  blindingKey: Uint8Array,
): Promise<void> {
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

  const joinContent = {
    v: 1,
    name: input.name,
    message: input.message ?? "",
    rsvp_public: !!input.rsvpPublic,
  };

  const wraps: Promise<unknown>[] = [
    signerWrap(signer, inboxPubkey, {
      kind: KIND_JOIN_REQUEST,
      content: joinContent,
      tags: joinTags,
    }).then((w) => publishOrQueue(w as any, relays)),
  ];

  // Optional profile submission (21601) — profile text only in the walking skeleton.
  if (input.profile) {
    const submission = {
      v: 1,
      profile: input.profile,
      media: [] as unknown[],
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
    v: 1,
    a: ctx.coordinate,
    profile: input.profile,
    media: [] as unknown[],
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

  await Promise.all(wraps);
}
