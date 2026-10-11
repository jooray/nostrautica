/**
 * The attendee half of the space hierarchy (PROTOCOL-NIP.md §15.5): joining a
 * community because you joined one of its events.
 *
 * Three pieces of per-(owner, child) state, all in the owner-scoped cache so a
 * logout takes them with it:
 *
 *  - the PROOF the child's grant carried (`parentproof:<child>`),
 *  - the CONSENT given on the child's join form (`parentconsent:<child>`),
 *  - whether the person answered "not now" to the offer card (same record).
 *
 * The one rule: nothing is sent to a community the person did not agree to. A
 * proof with consent ON joins automatically; a proof with no recorded answer
 * (they joined before this existed, or the grant was re-issued after a link) only
 * ever becomes a card they tap. See {@link decideCommunityJoin}.
 *
 * Eviction of these cache entries fails safe: a lost consent is "unknown", which
 * offers; it never joins.
 */
import {
  coordinateToNaddr,
  isCommunityCoordinate,
  isLinked,
  type AttendeeProfile,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import { joinSentAt, markJoinSent } from "$lib/stores/join-sent.svelte.js";
import { recentEvents } from "$lib/stores/recent-events.svelte.js";
import { deriveBlindingKey } from "./blinding.js";
import { loadEventContext, eventRelayHints } from "./event-context.js";
import { loadEventKeys, currentEck } from "./keystore.js";
import { sendJoinRequest } from "./join.js";
import { decideCommunityJoin, fetchNewestConfig, type CommunityJoinDecision } from "./hierarchy.js";
import { loadSelfCopy } from "$lib/media/submit.js";
import { fetchProfiles } from "./social.js";

/** A membership proof as carried in a key grant's `parent` field. */
export interface StoredParentProof {
  /** The community's coordinate. */
  a: string;
  by: string;
  sig: string;
}

export interface ParentConsent {
  parent: string;
  /** The checkbox on the child's join form. */
  consent: boolean;
  /** The display name the person gave the child, reused for the community join. */
  name?: string;
  /** They tapped "Not now" on the offer card. */
  dismissed?: boolean;
}

const proofKey = (child: string) => `parentproof:${child}`;
const consentKey = (child: string) => `parentconsent:${child}`;

// Children this identity holds a proof for, so a later scan can retry a join that
// failed (offline, relay gap): the grant that carried the proof is memoized as
// processed and will not be seen again.
const INDEX_KEY = "parentproof:index";
const MAX_INDEXED = 200;

export function proofChildren(): string[] {
  return cacheGet<string[]>(INDEX_KEY)?.data ?? [];
}

export function storeParentProof(child: string, proof: StoredParentProof): void {
  cacheSet(proofKey(child), proof);
  const rest = proofChildren().filter((c) => c !== child);
  cacheSet(INDEX_KEY, [...rest, child].slice(-MAX_INDEXED));
}

export function loadParentProof(child: string): StoredParentProof | undefined {
  return cacheGet<StoredParentProof>(proofKey(child))?.data;
}

export function recordParentConsent(child: string, c: ParentConsent): void {
  cacheSet(consentKey(child), c);
}

export function loadParentConsent(child: string): ParentConsent | undefined {
  return cacheGet<ParentConsent>(consentKey(child))?.data;
}

/** "Not now" on the offer card: keep the proof, stop asking. */
export function dismissCommunityOffer(child: string): void {
  const prior = loadParentConsent(child);
  const proof = loadParentProof(child);
  const parent = prior?.parent ?? proof?.a;
  if (!parent) return;
  recordParentConsent(child, { ...prior, parent, consent: prior?.consent ?? false, dismissed: true });
}

/** Whether this identity already belongs to, or is waiting on, a community. */
export async function communityStanding(
  parent: string,
): Promise<{ isMember: boolean; isPending: boolean }> {
  const keys = await loadEventKeys(parent).catch(() => undefined);
  return {
    isMember: !!currentEck(keys),
    isPending: joinSentAt(parent) !== undefined,
  };
}

export interface CommunityOffer {
  decision: CommunityJoinDecision;
  proof?: StoredParentProof;
  consent?: ParentConsent;
}

/** What should happen about `child`'s community right now (pure state + keystore read). */
export async function evaluateCommunityOffer(child: string): Promise<CommunityOffer> {
  const proof = loadParentProof(child);
  const consent = loadParentConsent(child);
  if (!proof || !isCommunityCoordinate(proof.a)) return { decision: "none" };
  const standing = await communityStanding(proof.a);
  // A consent given for a different community than the proof names is not consent
  // for this one (the organizer re-pointed the event).
  const applicable = consent && consent.parent === proof.a ? consent : undefined;
  return {
    decision: decideCommunityJoin({
      hasProof: true,
      consent: applicable?.consent,
      dismissed: applicable?.dismissed,
      isMember: standing.isMember,
      isPending: standing.isPending,
    }),
    proof,
    consent: applicable,
  };
}

const inFlight = new Set<string>();

/**
 * Send the community join for `child`: a 21600 carrying `member_of`, a copy of the
 * profile given to the child as a 21601, and the community's own 31602 self-copy
 * (all by `sendJoinRequest`). The person's own signer seals it (§15.3). Returns
 * false when nothing was sent (no proof, link since withdrawn, already in flight).
 */
export async function joinCommunityViaChild(
  signer: AppSigner,
  child: string,
  opts: { name?: string } = {},
): Promise<boolean> {
  const proof = loadParentProof(child);
  if (!proof || !isCommunityCoordinate(proof.a)) return false;
  const parent = proof.a;
  if (inFlight.has(parent)) return false;
  inFlight.add(parent);
  try {
    const standing = await communityStanding(parent);
    if (standing.isMember || standing.isPending) return false;

    const relays = eventRelayHints(child);
    const childCfg = await fetchNewestConfig(child, relays);
    const parentCfg = await fetchNewestConfig(parent, relays);
    // The link must still hold on both sides, or the community will queue the
    // request for a manual look instead of admitting it: say nothing rather than
    // make a request the person did not expect to be a manual one.
    if (!childCfg || !parentCfg || !isLinked(parent, parentCfg, child, childCfg)) return false;

    const parentCtx = await loadEventContext(coordinateToNaddr(parent, parentCfg.relays), { adoptLang: false });
    const childCtx = await loadEventContext(coordinateToNaddr(child, childCfg.relays), { adoptLang: false });
    const blindingKey = await deriveBlindingKey(signer);
    const self = await loadSelfCopy(signer, childCtx, blindingKey).catch(() => undefined);
    const profile: AttendeeProfile | undefined = self?.profile;
    const pubkey = await signer.getPublicKey();
    const name =
      opts.name ??
      loadParentConsent(child)?.name ??
      (await fetchProfiles([pubkey]).catch(() => new Map()).then((m) => m.get(pubkey)?.name)) ??
      "";

    await sendJoinRequest(
      signer,
      parentCtx,
      { name, profile, memberOf: { child, by: proof.by, sig: proof.sig } },
      blindingKey,
    );
    markJoinSent(parent);
    // The same trail a join from the community's own page leaves, so Home lists it
    // as a pending space instead of the request vanishing into thin air.
    recentEvents.record({
      coordinate: parent,
      naddr: parentCtx.naddr,
      title: parentCtx.title,
      icon: parentCtx.icon,
      role: "attendee",
    });
    const prior = loadParentConsent(child);
    recordParentConsent(child, { ...prior, parent, consent: true, name, dismissed: false });
    return true;
  } finally {
    inFlight.delete(parent);
  }
}

/**
 * After a grant scan: for each child whose grant just carried a proof, join the
 * community if (and only if) the person consented at the join form. Never throws —
 * it runs inside the grant scan and must not be able to fail it.
 */
export async function autoJoinCommunities(signer: AppSigner, children: string[]): Promise<string[]> {
  const joined: string[] = [];
  for (const child of children) {
    try {
      const offer = await evaluateCommunityOffer(child);
      if (offer.decision !== "join") continue;
      if (await joinCommunityViaChild(signer, child)) joined.push(offer.proof!.a);
    } catch (e) {
      console.warn("[community-join] automatic community join failed for", child, e);
    }
  }
  return joined;
}
