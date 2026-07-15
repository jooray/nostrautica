/** @module @category Client - Proposals */
import { ProposalRemove } from "ts-mls";
import { ProposalAction } from "../marmot-group.js";
/**
 * Proposes removing all leaf nodes (devices/clients) for a given Nostr user.
 * This returns a ProposalBuilder that creates an array of remove proposals.
 *
 * @param pubkey - The Nostr public key (hex string) of the user to kick
 * @returns A ProposalBuilder that returns an array of ProposalRemove proposals
 */
export declare function proposeRemoveUser(pubkey: string): ProposalAction<ProposalRemove[]>;
