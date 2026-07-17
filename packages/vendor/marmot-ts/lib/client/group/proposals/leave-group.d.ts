/** @module @category Client - Proposals */
import { ProposalSelfRemove } from "ts-mls";
import { ProposalAction } from "../marmot-group.js";
/**
 * Proposes the caller's own departure via an MLS `self_remove` proposal
 * (Marmot v2 `protocol-core/member-departure.md`). The proposal body is empty —
 * the leaving member is identified by the proposal's MLS sender — so it is
 * committed by *another* member (the deterministic auto-committer, or an admin),
 * never by the leaver: RFC 9420 §12.2 forbids a committer from removing their
 * own leaf, which is exactly the case `self_remove` is designed for.
 *
 * Unlike the legacy self-targeted `Remove`, a single `self_remove` covers the
 * sender regardless of how many leaves they hold; the leaf lookup here only
 * guards that the caller is actually a member.
 *
 * @param pubkey - The Nostr public key (hex string) of the member leaving.
 * @returns A {@link ProposalAction} yielding one {@link ProposalSelfRemove}.
 */
export declare function proposeLeaveGroup(pubkey: string): ProposalAction<ProposalSelfRemove[]>;
