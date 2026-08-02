/**
 * Join flow (spec §8) regression coverage.
 *
 * BUG (prod incident 2026-07-23): the 21601 Profile Submission built here omitted
 * the REQUIRED `rev` field (NIP §3.3). `profileSubmissionContentSchema` mandates
 * it, so the coordinator dropped every join-time submission as permanently
 * unprocessable ("invalid_type … path rev") — an attendee's join-time
 * skills/looking_for never reached matching. These tests assert the submission
 * now parses, and that join shares ONE monotonic per-event rev counter with the
 * later Record/profile edits (a post-join edit must supersede the join).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  KIND_PROFILE_SUBMISSION,
  profileSubmissionContentSchema,
  type AttendeeProfile,
} from "@nostrautica/protocol";

// Capture what sendJoinRequest hands to signerWrap (the plaintext rumor content,
// before gift-wrap encryption) so we can validate it against the schema.
const wrapCalls: Array<{ kind: number; content: unknown }> = [];
vi.mock("./giftwrap.js", () => ({
  signerWrap: vi.fn(async (_signer, _recipient, input: { kind: number; content: unknown }) => {
    wrapCalls.push({ kind: input.kind, content: input.content });
    return { kind: 1059, id: "wrap", content: "", tags: [], created_at: 0, pubkey: "", sig: "" };
  }),
}));
vi.mock("$lib/nostr/publish-queue.js", () => ({
  publishOrQueue: vi.fn(async () => true),
}));
// loadSelfCopy is the shared rev source: undefined on a first join (rev 0), or a
// prior self-copy whose rev the join must bump past.
const loadSelfCopy = vi.fn(async () => undefined as { rev?: number } | undefined);
// The join seeds the local self-copy so the intro flow that follows has
// something to fall back on when its own relay read comes back empty.
const cacheSelfCopy = vi.fn();
vi.mock("$lib/media/submit.js", () => ({
  loadSelfCopy: (...args: unknown[]) => loadSelfCopy(...(args as [])),
  cacheSelfCopy: (...args: unknown[]) => cacheSelfCopy(...(args as [])),
}));

import { sendJoinRequest } from "./join.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";

const fakeSigner = {
  getPublicKey: async () => "a".repeat(64),
  nip44Encrypt: async (_pk: string, plaintext: string) => `enc(${plaintext})`,
  signEvent: async (e: Record<string, unknown>) => ({ ...e, id: "id", sig: "sig", pubkey: "a".repeat(64) }),
} as unknown as AppSigner;

const ctx = {
  coordinate: "31600:" + "a".repeat(64) + ":my-event",
  config: { inbox: "b".repeat(64), relays: ["wss://relay.example"] },
} as unknown as EventContext;

const profile: AttendeeProfile = {
  about: "builds things",
  skills: ["rust"],
  looking_for: "collaborators",
  links: [],
};
const blindingKey = new Uint8Array(32).fill(7);

function submissionContent(): unknown | undefined {
  return wrapCalls.find((c) => c.kind === KIND_PROFILE_SUBMISSION)?.content;
}

describe("sendJoinRequest — 21601 profile submission carries a valid rev", () => {
  beforeEach(() => {
    wrapCalls.length = 0;
    loadSelfCopy.mockReset();
    loadSelfCopy.mockResolvedValue(undefined);
    cacheSelfCopy.mockClear();
  });

  it("builds a submission that PARSES against profileSubmissionContentSchema", async () => {
    await sendJoinRequest(fakeSigner, ctx, { name: "Ada", profile }, blindingKey);
    const content = submissionContent();
    expect(content).toBeDefined();
    // The bug: this parse threw on a missing `rev`. It must now succeed.
    const parsed = profileSubmissionContentSchema.parse(content);
    expect(parsed.rev).toBe(0); // a first join is rev 0
  });

  it("shares one monotonic counter with later edits — a prior self-copy bumps rev", async () => {
    loadSelfCopy.mockResolvedValue({ rev: 2 });
    await sendJoinRequest(fakeSigner, ctx, { name: "Ada", profile }, blindingKey);
    const parsed = profileSubmissionContentSchema.parse(submissionContent());
    expect(parsed.rev).toBe(3); // supersedes rev 2, so a re-join can't regress
  });

  it("still parses when loadSelfCopy fails (fail-soft to rev 0)", async () => {
    loadSelfCopy.mockRejectedValue(new Error("relay down"));
    await sendJoinRequest(fakeSigner, ctx, { name: "Ada", profile }, blindingKey);
    const parsed = profileSubmissionContentSchema.parse(submissionContent());
    expect(parsed.rev).toBe(0);
  });

  it("seeds the local self-copy with the fields just typed", async () => {
    // The next screen is "record your intro", which builds its submission from
    // the self-copy. Leaving the joining device with no local copy is what let
    // an empty relay read there blank the profile written on the join form.
    await sendJoinRequest(fakeSigner, ctx, { name: "Ada", profile }, blindingKey);
    expect(cacheSelfCopy).toHaveBeenCalledTimes(1);
    const [coordinate, self] = cacheSelfCopy.mock.calls[0] as [string, { profile: unknown; rev: number }];
    expect(coordinate).toBe(ctx.coordinate);
    expect(self.profile).toEqual(profile);
    expect(self.rev).toBe(0);
  });
});
