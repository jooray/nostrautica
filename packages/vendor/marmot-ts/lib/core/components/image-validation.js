/** @module @category Core - App Components */
import { appDataUpdateProposalType, getAppDataDictionary, getCredentialFromLeafIndex, nodeTypes, } from "../../vendor/ts-mls/index.js";
import { getCredentialPubkey } from "../credential.js";
import { decodeGroupBlossomImage } from "./blossom-image.js";
import { getAdminPolicy } from "./dictionary.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "./ids.js";
import { bytesEqual } from "./bytes.js";
function violation(detail) {
    return {
        kind: "violation",
        violation: { reason: "component-integrity", detail },
    };
}
/**
 * Pure image admission against authenticated occupied parent leaves. Inline
 * proposals belong to the committer; references retain their original sender.
 * Missing attribution is undecidable; invalid leaf evidence is a violation.
 * @see refs/marmot/app-components/group-blossom-image-v1.md
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs authorize_staged_commit_proposals
 */
export function validateGroupImageProposals(args) {
    const imageProposals = args.proposals.flatMap((item) => {
        const proposal = "proposal" in item ? item.proposal : item;
        if (proposal.proposalType !== appDataUpdateProposalType ||
            !("appDataUpdate" in proposal) ||
            proposal.appDataUpdate.componentId !== GROUP_BLOSSOM_IMAGE_COMPONENT_ID)
            return [];
        return [
            {
                proposal,
                senderLeafIndex: "proposal" in item ? item.senderLeafIndex : args.committerLeafIndex,
            },
        ];
    });
    if (imageProposals.length === 0)
        return { kind: "legal" };
    // Check all payloads first: malformed evidence outranks unavailable senders.
    for (const { proposal } of imageProposals) {
        if (proposal.appDataUpdate.operation === "update") {
            try {
                decodeGroupBlossomImage(proposal.appDataUpdate.update);
            }
            catch {
                return violation("group image AppDataUpdate payload does not decode");
            }
        }
    }
    let missing = false;
    const indexes = imageProposals.map(({ senderLeafIndex }) => senderLeafIndex);
    if (args.requireCommitter)
        indexes.push(args.committerLeafIndex);
    for (const index of indexes) {
        if (index === undefined) {
            missing = true;
            continue;
        }
        try {
            if (!Number.isSafeInteger(index) ||
                index < 0 ||
                args.ratchetTree[index * 2]?.nodeType !== nodeTypes.leaf)
                return violation("group image actor has no occupied candidate-parent leaf");
            const pubkey = getCredentialPubkey(getCredentialFromLeafIndex(args.ratchetTree, index));
            if (!args.adminPubkeys.includes(pubkey))
                return violation("group image actor is not a candidate-parent admin");
        }
        catch {
            return violation("group image candidate-parent actor identity is invalid");
        }
    }
    return missing
        ? {
            kind: "undecidable",
            detail: "group image proposal or committer attribution is unavailable",
        }
        : { kind: "legal" };
}
/** Shared normal/replay adapter: result encoding is checked, roles come only from the parent. */
export function validateGroupImageLegality(args) {
    let imageChanged = false;
    let resultingImage;
    if (args.resultingState) {
        try {
            const image = getAppDataDictionary(args.resultingState.groupContext.extensions)?.find((entry) => entry.componentId === GROUP_BLOSSOM_IMAGE_COMPONENT_ID);
            if (image)
                decodeGroupBlossomImage(image.data);
            resultingImage = image?.data;
            const parentImage = getAppDataDictionary(args.parentState.groupContext.extensions)?.find((entry) => entry.componentId === GROUP_BLOSSOM_IMAGE_COMPONENT_ID);
            imageChanged = !bytesEqual(parentImage?.data, resultingImage);
        }
        catch {
            return violation("resulting group image component did not decode");
        }
    }
    // An unrelated operation needs no image actor attribution or role parsing.
    const hasImageProposal = args.proposals.some((item) => {
        const proposal = "proposal" in item ? item.proposal : item;
        return (proposal.proposalType === appDataUpdateProposalType &&
            "appDataUpdate" in proposal &&
            proposal.appDataUpdate.componentId === GROUP_BLOSSOM_IMAGE_COMPONENT_ID);
    });
    if (!hasImageProposal && !imageChanged)
        return { kind: "legal" };
    let admins;
    try {
        admins = getAdminPolicy(args.parentState.groupContext.extensions) ?? [];
    }
    catch {
        return violation("candidate-parent admin-policy component did not decode");
    }
    return validateGroupImageProposals({
        ratchetTree: args.parentState.ratchetTree,
        adminPubkeys: admins,
        // A recorded dictionary diff independently proves an image mutation even
        // when its proposal bodies are unavailable. It proves the committer role,
        // never the original referenced author's identity. Missing attribution
        // remains undecidable for callers to apply their existing fallback policy.
        proposals: hasImageProposal
            ? args.proposals
            : [
                {
                    proposalType: appDataUpdateProposalType,
                    appDataUpdate: resultingImage === undefined
                        ? {
                            componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                            operation: "remove",
                        }
                        : {
                            componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                            operation: "update",
                            update: resultingImage,
                        },
                },
            ],
        committerLeafIndex: args.committerLeafIndex,
        requireCommitter: true,
    });
}
