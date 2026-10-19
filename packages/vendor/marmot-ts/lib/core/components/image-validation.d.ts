/** @module @category Core - App Components */
import { type ClientState, type Proposal, type ProposalWithSender } from "../../vendor/ts-mls/index.js";
import type { CommitLegalityOutcome } from "./integrity.js";
/**
 * Pure image admission against authenticated occupied parent leaves. Inline
 * proposals belong to the committer; references retain their original sender.
 * Missing attribution is undecidable; invalid leaf evidence is a violation.
 * @see refs/marmot/app-components/group-blossom-image-v1.md
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs authorize_staged_commit_proposals
 */
export declare function validateGroupImageProposals(args: {
    ratchetTree: ClientState["ratchetTree"];
    adminPubkeys: readonly string[];
    proposals: readonly (Proposal | ProposalWithSender)[];
    committerLeafIndex?: number;
    requireCommitter?: boolean;
}): CommitLegalityOutcome;
/** Shared normal/replay adapter: result encoding is checked, roles come only from the parent. */
export declare function validateGroupImageLegality(args: {
    parentState: ClientState;
    resultingState?: ClientState;
    proposals: readonly (Proposal | ProposalWithSender)[];
    committerLeafIndex?: number;
}): CommitLegalityOutcome;
