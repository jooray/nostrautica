/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";
import { contentTypes, encode, getCredentialFromLeafIndex, mlsMessageEncoder, processMessage, ValidationError, wireformats, } from "../vendor/ts-mls/index.js";
import { verifyApplicationRumorAuthorship } from "../core/application-rumor.js";
import { getGroupProfileSupport } from "../core/components/account-identity-proof.js";
import { marmotAuthService } from "../core/auth-service.js";
import { defaultMarmotClientConfig } from "../core/client-config.js";
import { validateCommitLegality, validateUpdateProposalAccountIdentityProofs, } from "../core/components/integrity.js";
import { classifyDisbandCommit } from "../core/components/disband-validation.js";
import { commitDigest, compareCommitOrderingKeys, } from "../core/convergence.js";
import { getCredentialPubkey } from "../core/credential.js";
import { deferredReasons } from "../core/inbound.js";
import { classifyLateCommit } from "../core/retained-history.js";
import { requiredComponentIdsOf, validatePreApplyProposals, withCapturedProposals, } from "./admin-policy.js";
import { contentDedupId } from "./message-dedup.js";
import { deriveStateNotifications, groupWithdrawnNotificationsByCommit, } from "./state-notifications.js";
import { framedContentType, framedEpoch } from "./wire-format.js";
/**
 * A decryption failure that retrying can never recover. The MLS secret tree
 * only ratchets forward, so once a generation's secret has been consumed and
 * deleted (forward secrecy) it is gone for good; ts-mls signals this with a
 * {@link ValidationError} "Desired gen in the past". This is expected — and
 * benign — for a member's own application messages replayed by a relay and for
 * duplicate deliveries. Re-attempting against the same (or a further-advanced)
 * state is byte-for-byte futile, so these are dropped as unreadable on the
 * first pass instead of churning through the retry loop.
 */
function isPermanentDecryptFailure(error) {
    return (error instanceof ValidationError &&
        error.message.includes("Desired gen in the past"));
}
/** A short, stable label for an envelope in debug logs. */
function envelopeLabel(envelope) {
    if (envelope &&
        typeof envelope === "object" &&
        "id" in envelope &&
        typeof envelope.id === "string") {
        return envelope.id.slice(0, 8);
    }
    return "?";
}
/**
 * Resolves a still-unprocessed envelope to its terminal {@link IngestResult}:
 * `deferred` (retryable — missing parent / future epoch) when the batch marked
 * it as such, otherwise `unreadable` (terminal). Keeping deferred inputs out of
 * `unreadable` is what stops a future-epoch commit being mislabeled
 * `stale: invalid_encoding` (`protocol-core/inbound-processing.md`).
 */
function terminalResult(envelope, deferred, errorList, decryptFailed) {
    const entry = deferred.get(envelope);
    if (entry)
        return {
            kind: "deferred",
            envelope,
            message: entry.message,
            reason: entry.reason,
            sourceEpoch: Number(framedEpoch(entry.message) ?? 0n),
        };
    return {
        kind: "unreadable",
        envelope,
        errors: errorList
            .filter((e) => e.envelope === envelope)
            .map((e) => e.error),
        // A peel failure is retryable (the unlocking state may arrive later); the
        // engine pools these rather than dropping them.
        decryptFailure: decryptFailed.has(envelope) || undefined,
    };
}
/**
 * Whether a decrypted application message is authentic: its inner Nostr event
 * id is canonical AND its `pubkey` matches the MLS-authenticated sender's
 * account identity (`foundation/identity.md`, `protocol-core/group-messaging.md`).
 * MLS authenticates *who* sent the bytes (the sender leaf); this binds the inner
 * author to that sender so a member can't forge another account's authorship.
 * A failure — including an unattributable sender (no leaf index) or a
 * non-conformant payload — is `invalid_encoding`; the message is dropped, never
 * delivered.
 *
 * The sender leaf index refers to the ratchet tree of the epoch the message
 * was sent in. For a message from a past epoch that tree is the retained
 * `historicalReceiverData` entry, not `state.ratchetTree`: the sender may have
 * been removed (or the leaf reused) since. Pass `messageEpoch` so the right
 * tree is used; MDK reads the credential the same way (OpenMLS
 * `ProcessedMessage::credential`, `cgka-engine/src/identity.rs`).
 */
export function isAuthenticApplicationMessage(result, state, log, label, messageEpoch) {
    const senderLeafIndex = result
        .senderLeafIndex;
    if (senderLeafIndex === undefined) {
        log("reject app message envelope:%s – unattributable sender", label);
        return false;
    }
    try {
        const ratchetTree = messageEpoch !== undefined && messageEpoch < state.groupContext.epoch
            ? state.historicalReceiverData.get(messageEpoch)?.ratchetTree
            : state.ratchetTree;
        if (!ratchetTree)
            throw new Error(`no retained ratchet tree for epoch ${messageEpoch}`);
        const credential = getCredentialFromLeafIndex(ratchetTree, senderLeafIndex);
        const senderPubkey = getCredentialPubkey(credential);
        verifyApplicationRumorAuthorship(result.message, senderPubkey);
        return true;
    }
    catch (error) {
        log("reject app message envelope:%s – %s", label, error.message);
        return false;
    }
}
/** Orders peeled commits deterministically by their convergence ordering key. */
function sortPeeledCommits(commits) {
    const keyed = commits.map((pair) => {
        const sourceEpoch = Number(framedEpoch(pair.message) ?? 0n);
        const key = {
            sourceEpoch,
            commitDigest: commitDigest(encode(mlsMessageEncoder, pair.message)),
        };
        return { pair, key };
    });
    keyed.sort((a, b) => compareCommitOrderingKeys(a.key, b.key));
    return keyed.map((entry) => entry.pair);
}
/**
 * Ingests transport envelopes and applies MLS messages to group state
 * (Marmot v2 `protocol-core/inbound-processing.md`). Decrypts (retrying against
 * retained states), splits commits from non-commits, applies in-order commits,
 * routes past/future-epoch commits through convergence fork recovery, and
 * retries out-of-order messages only while a pass made progress.
 *
 * This is the engine's `message_processor/ingest` seam, extracted from
 * `MarmotGroupEngine` so the 400-line pipeline can be read and tested in
 * isolation from send and lifecycle.
 */
export async function* ingestEnvelopes(ctx, envelopes, options) {
    const log = ctx.log.extend(`ingest:${Date.now().toString(36).slice(-5)}`);
    // D-04: canonical disband is an absorbing input gate. Keep this before even
    // reading ClientState so direct engine callers cannot reopen crypto,
    // convergence passes, timers, dedup, or application delivery.
    if (ctx.isDisbanded?.()) {
        for (const envelope of envelopes)
            yield { kind: "skipped", envelope, reason: "group-disbanded" };
        return;
    }
    // D-13: once canonical state is the removedFromGroup tombstone, later input
    // for this group is classified `self-evicted` before any per-message work —
    // no peel, no decrypt, no authentication (`protocol-core/member-departure.md`
    // "Realizing removal": such input "need not be decrypted or authenticated").
    // This must be the very first check in the function, ahead of the peel call,
    // so a whole batch short-circuits uniformly regardless of retry state.
    if (ctx.getState().groupActiveState.kind === "removedFromGroup") {
        log("group is removedFromGroup – yielding %d envelope(s) as self-evicted", envelopes.length);
        for (const envelope of envelopes) {
            yield { kind: "skipped", envelope, reason: "self-evicted" };
        }
        return;
    }
    // D-11: a stored group outside the current account-identity-proof profile
    // (legacy, mixed, or missing the `0x8009` requirement) refuses ALL inbound
    // traffic, including application messages — classified from canonical
    // GroupContext before any peel or decrypt, mirroring the disband/self-evicted
    // gates above. This supersedes Phase 7 D-10 ("load untouched"): commit
    // legality would already reject every commit for such a group (08-01 D-01a),
    // but application messages and proposals would otherwise still flow.
    // @see refs/marmot/app-components/account-identity-proof-v2.md "Migration from v1"
    const profileSupport = getGroupProfileSupport(ctx.getState().groupContext.extensions);
    if (profileSupport.kind === "unsupported") {
        log("group outside the current account identity proof profile (%s) – yielding %d envelope(s) as unsupported-profile", profileSupport.proofReason, envelopes.length);
        for (const envelope of envelopes) {
            yield { kind: "skipped", envelope, reason: "unsupported-profile" };
        }
        return;
    }
    const retryCount = options?.retryCount ?? 0;
    const maxRetries = options?.maxRetries ?? 5;
    const errorList = options?._errors ?? [];
    // Envelopes deferred this batch (future-epoch / missing-parent commits). They
    // ride the same retry set as `unreadable` so a later pass can apply them once
    // the gap fills, but at a terminal yield they surface as `deferred`, not stale.
    const deferred = options?._deferred ?? new Map();
    // Envelopes whose kind-445 wrapper never opened (peel failures) — retryable,
    // so they surface as `unreadable` with `decryptFailure` set for the pool.
    const decryptFailedAll = options?._decryptFailed ?? new Set();
    if (retryCount === 0) {
        log("start – %d envelope(s), maxRetries=%d", envelopes.length, maxRetries);
    }
    else {
        log("retry %d/%d – %d envelope(s) remaining", retryCount, maxRetries, envelopes.length);
    }
    if (retryCount > maxRetries) {
        log("max retries exceeded – yielding %d envelope(s) as deferred/unreadable", envelopes.length);
        for (const envelope of envelopes) {
            yield terminalResult(envelope, deferred, errorList, decryptFailedAll);
        }
        return;
    }
    if (envelopes.length === 0)
        return;
    // Snapshot the state so we can tell whether this pass advanced anything.
    // Every successful apply replaces it via setState, so identity inequality
    // means progress. Retrying envelopes against an unchanged state is
    // deterministic and can only reproduce the same failures.
    const stateBeforePass = ctx.getState();
    let { read, unreadable: decryptFailed } = await ctx.peeler.peelGroupMessages(envelopes, ctx.getState());
    if (decryptFailed.length > 0 && ctx.retained.size > 0) {
        const stillFailed = [];
        for (const envelope of decryptFailed) {
            let recovered = false;
            for (const retained of ctx.retained.states()) {
                if (retained === ctx.getState())
                    continue;
                const retry = await ctx.peeler.peelGroupMessages([envelope], retained);
                if (retry.read.length > 0) {
                    read = [...read, ...retry.read];
                    recovered = true;
                    break;
                }
            }
            if (!recovered)
                stillFailed.push(envelope);
        }
        decryptFailed = stillFailed;
    }
    log("decryption: %d/%d readable, %d failed", read.length, envelopes.length, decryptFailed.length);
    for (const envelope of decryptFailed) {
        log("decrypt failed envelope:%s", envelopeLabel(envelope));
        decryptFailedAll.add(envelope);
        errorList.push({
            envelope,
            error: new Error("Failed to decrypt group message"),
        });
    }
    if (read.length === 0) {
        log("nothing readable – yielding %d decrypt failure(s) as unreadable", decryptFailed.length);
        for (const envelope of decryptFailed) {
            yield {
                kind: "unreadable",
                envelope,
                errors: errorList
                    .filter((e) => e.envelope === envelope)
                    .map((e) => e.error),
                decryptFailure: true,
            };
        }
        return;
    }
    const unreadable = [...decryptFailed];
    // Content-derived dedup (`inbound-processing.md`): before any MLS processing or
    // convergence classification, drop a message whose content we have already
    // terminally processed (`duplicate`) or that is our own send replayed back in a
    // fresh transport envelope (`own-echo` → reported as `self-echo`). Keyed on the
    // peeled MLS bytes, so a re-wrap with a new Nostr event id is still caught.
    // Intra-batch repeats collapse to the first occurrence as well.
    const batchSeen = new Set();
    const fresh = [];
    for (const pair of read) {
        const id = contentDedupId(pair.message);
        const cls = ctx.dedup.classify(pair.message);
        if (cls === "own-echo") {
            log("skip envelope:%s reason:self-echo (own send)", envelopeLabel(pair.envelope));
            yield {
                kind: "skipped",
                envelope: pair.envelope,
                message: pair.message,
                reason: "self-echo",
            };
            continue;
        }
        if (cls === "duplicate" || batchSeen.has(id)) {
            log("skip envelope:%s reason:duplicate", envelopeLabel(pair.envelope));
            yield {
                kind: "skipped",
                envelope: pair.envelope,
                message: pair.message,
                reason: "duplicate",
            };
            continue;
        }
        batchSeen.add(id);
        fresh.push(pair);
    }
    let commits = [];
    const nonCommits = [];
    for (const pair of fresh) {
        // Commits are MLS PublicMessage under Marmot v2 (see wire-format.ts); other
        // framed content (application, proposals) goes through the non-commit path.
        if (framedContentType(pair.message) === contentTypes.commit) {
            commits.push(pair);
        }
        else {
            nonCommits.push(pair);
        }
    }
    log("split: %d commit(s), %d non-commit(s)", commits.length, nonCommits.length);
    // CR-01: the admin callback is rebuilt for EVERY message from the state that
    // message is processed on. A callback built once per batch captures the
    // pre-batch admin set and ratchet tree by value, so a commit applied earlier
    // in this batch (a demotion, a promotion, a leaf reassignment) would not
    // change the verdict for the next one — accepting a same-batch demoted
    // admin's commit that a peer receiving it separately rejects. Mirrors MDK,
    // which authorizes against the `MlsGroup` each commit is staged on.
    for (const { envelope, message } of nonCommits) {
        try {
            if (message.wireformat !== wireformats.mls_private_message &&
                message.wireformat !== wireformats.mls_public_message) {
                log("skip envelope:%s reason:wrong-wireformat", envelopeLabel(envelope));
                yield {
                    kind: "skipped",
                    envelope,
                    message,
                    reason: "wrong-wireformat",
                };
                continue;
            }
            const parentForAuth = ctx.getState();
            const capture = withCapturedProposals(ctx.createAdminCallback(parentForAuth));
            const result = await processMessage({
                context: {
                    cipherSuite: ctx.ciphersuite,
                    authService: marmotAuthService,
                    clientConfig: defaultMarmotClientConfig,
                    externalPsks: {},
                },
                state: parentForAuth,
                message,
                callback: capture.callback,
            });
            const captured = capture.take();
            if (result.kind === "newState" && result.actionTaken === "reject") {
                // D-09/D-10 (UPD-04): a standalone Add proposal with a missing or
                // invalid 0x8009 proof, OR a standalone Update proposal with an
                // unresolvable sender / invalid proof / changed account identity, is
                // refused here before it is staged. Only the ratchet advance
                // (result.newState) is applied -- ts-mls never stages a rejected
                // proposal's effect, mirroring the application-message branch's
                // ratchet-advance-only handling below -- and recordProposalStaged is
                // deliberately never called. Re-derives the specific violation (not
                // just the accept/reject verdict the callback already made) so the
                // result and audit trail carry the real account-identity-proof
                // reason/proofReason rather than the generic admin-policy fallback.
                const violation = validatePreApplyProposals(captured.proposals, ctx.ciphersuite.id) ??
                    validateUpdateProposalAccountIdentityProofs(captured.proposals, parentForAuth.ratchetTree, ctx.ciphersuite.id);
                ctx.setState(result.newState);
                ctx.dedup.remember(message);
                log("proposal envelope:%s rejected reason:%s", envelopeLabel(envelope), violation?.reason ?? "admin-policy");
                yield {
                    kind: "rejected",
                    result,
                    envelope,
                    message,
                    reason: violation?.reason ?? "admin-policy",
                    proofReason: violation?.proofReason,
                };
                continue;
            }
            if (result.kind === "newState") {
                log("proposal accepted envelope:%s epoch:%d", envelopeLabel(envelope), ctx.getState().groupContext.epoch);
                ctx.setState(result.newState);
                ctx.recordProposalStaged(result.newState);
                ctx.dedup.remember(message);
                yield { kind: "processed", result, envelope, message };
            }
            else if (result.kind === "applicationMessage") {
                // The MLS layer has authenticated the sender; advance our ratchet to
                // reflect the consumed generation even if we then drop the payload.
                ctx.setState(result.newState);
                if (!isAuthenticApplicationMessage(result, result.newState, log, envelopeLabel(envelope), framedEpoch(message))) {
                    // M3: forged inner id / author ⇒ invalid_encoding, never delivered.
                    yield {
                        kind: "skipped",
                        envelope,
                        message,
                        reason: "invalid-app-payload",
                    };
                    continue;
                }
                // Remember this eager delivery keyed by the branch state it decrypted
                // against (epoch + confirmation tag); a later rewind abandoning this
                // branch retracts it as `invalidated` (M7). An app message advances the
                // ratchet but not the epoch/confirmation tag, so newState identifies the
                // delivery branch.
                ctx.recordDeliveredAppPayload(Number(result.newState.groupContext.epoch), bytesToHex(result.newState.confirmationTag), envelope, message, result.message);
                ctx.dedup.remember(message);
                log("application message envelope:%s", envelopeLabel(envelope));
                yield { kind: "processed", result, envelope, message };
            }
        }
        catch (error) {
            if (isPermanentDecryptFailure(error)) {
                log("non-commit permanently unreadable envelope:%s – %s", envelopeLabel(envelope), error.message);
                yield { kind: "unreadable", envelope, errors: [error] };
                continue;
            }
            log("non-commit failed envelope:%s – queued for retry: %O", envelopeLabel(envelope), error);
            errorList.push({ envelope, error });
            unreadable.push(envelope);
        }
    }
    commits = sortPeeledCommits(commits);
    const forkPool = [];
    for (const { envelope, message } of commits) {
        // A commit is always framed (private or public); guard narrows the type and
        // defends against a non-framed message reaching the commit path.
        if (message.wireformat !== wireformats.mls_private_message &&
            message.wireformat !== wireformats.mls_public_message) {
            log("skip commit envelope:%s reason:wrong-wireformat", envelopeLabel(envelope));
            yield { kind: "skipped", envelope, message, reason: "wrong-wireformat" };
            continue;
        }
        const commitEpoch = framedEpoch(message) ?? 0n;
        const currentEpoch = ctx.getState().groupContext.epoch;
        if (commitEpoch < currentEpoch) {
            forkPool.push({ envelope, message, epoch: Number(commitEpoch) });
            continue;
        }
        if (commitEpoch > currentEpoch + 1n) {
            // A commit more than one epoch ahead is missing the intermediate parent
            // commit(s) that would advance us to its source epoch. That parent may
            // still arrive (this or a later batch), so this is retryable `deferred`
            // (missing_parent), not a terminal error. It rides `unreadable` for the
            // in-batch retry but `deferred` remembers it for the terminal yield.
            log("defer commit envelope:%s epoch:%d too far ahead (current=%d) – missing parent", envelopeLabel(envelope), commitEpoch, currentEpoch);
            deferred.set(envelope, {
                message,
                reason: deferredReasons.missingParent,
            });
            unreadable.push(envelope);
            continue;
        }
        log("processing commit envelope:%s epoch:%d->%d", envelopeLabel(envelope), currentEpoch, commitEpoch);
        try {
            // CR-01: authorize against this commit's own parent — the state after
            // every earlier commit in this batch was applied.
            const parentForAuth = ctx.getState();
            const capture = withCapturedProposals(ctx.createAdminCallback(parentForAuth));
            const result = await processMessage({
                context: {
                    cipherSuite: ctx.ciphersuite,
                    authService: marmotAuthService,
                    clientConfig: defaultMarmotClientConfig,
                    externalPsks: {},
                },
                state: parentForAuth,
                message,
                callback: capture.callback,
            });
            const capturedCommit = capture.take();
            if (result.kind === "newState") {
                if (result.actionTaken === "reject") {
                    // D-05: an admin-callback rejection caused by an Add-proof failure
                    // is labeled identically to every other Add-proof rejection seam
                    // (account-identity-proof + proofReason), not the generic
                    // admin-policy reason.
                    const addViolation = validatePreApplyProposals(capturedCommit.proposals, ctx.ciphersuite.id, requiredComponentIdsOf(parentForAuth));
                    log("commit envelope:%s rejected by admin policy reason:%s", envelopeLabel(envelope), addViolation?.reason ?? "admin-policy");
                    ctx.dedup.remember(message);
                    yield {
                        kind: "rejected",
                        result,
                        envelope,
                        message,
                        reason: addViolation?.reason ?? "admin-policy",
                        proofReason: addViolation?.proofReason,
                    };
                    continue;
                }
                const parentState = ctx.getState();
                // WIRE-03/CONV-01 (D-03): validate the commit's resulting GroupContext
                // AFTER processMessage returns (never inside the callback — Pitfall 1),
                // BEFORE canonical state advances. A violating commit is rejected here
                // and never reaches ctx.setState/ctx.recordCommit.
                const legalityOutcome = validateCommitLegality({
                    parentState,
                    resultingState: result.newState,
                    proposals: capturedCommit.proposals,
                    committerLeafIndex: capturedCommit.committerLeafIndex,
                });
                if (legalityOutcome.kind === "undecidable") {
                    // WR-02: `capturedCommit` holds this commit's COMPLETE proposal list
                    // — the ts-mls callback fired during the `processMessage` that just
                    // returned `newState`. So an undecidable verdict on this seam means
                    // the classification input WAS genuinely captured and the only
                    // missing piece is the committer: ts-mls leaves `committerLeafIndex`
                    // undefined for every non-`member` sender type. No future protocol
                    // bytes can give a commit a member sender it never had, so deferring
                    // is not "retry once more arrives" — it is a permanent hold. The
                    // envelope is pooled and re-ingested, every pass re-defers and sets
                    // `#lastPassUnresolved`, which derives `convergenceStatus =
                    // Resolving` and therefore gates ALL local outbound work until
                    // source-epoch eviction. `foundation/errors.md`'s deferral rule is
                    // for inputs that COULD become processable; a structurally
                    // unattributable committer never can, so this fails closed as a
                    // terminal rejection — the same disposition the Update-admission
                    // seam already gives an unresolvable sender.
                    if (capturedCommit.committerLeafIndex === undefined) {
                        log("commit envelope:%s rejected reason:account-identity-proof detail:%s", envelopeLabel(envelope), legalityOutcome.detail);
                        ctx.dedup.remember(message);
                        yield {
                            kind: "rejected",
                            result,
                            envelope,
                            message,
                            reason: "account-identity-proof",
                            proofReason: "unattributable-leaf",
                        };
                        continue;
                    }
                    // A committer IS known, so this undecidable came from incomplete
                    // classification rather than an unattributable sender. That can
                    // still clear, so it keeps the deferral idiom (D-03/D-04): the input
                    // stays retryable (no dedup.remember) and canonical state must not
                    // advance (no ctx.setState). Retry is bounded by the existing pool
                    // limits (maxSize plus source-epoch expiry against
                    // maxRewindCommits); the engine's ingest loop already pools any
                    // `kind: "deferred"` result, so no new retry mechanism is introduced.
                    const deferredReason = deferredReasons.unjudgeableIdentity;
                    log("commit envelope:%s deferred reason:%s detail:%s", envelopeLabel(envelope), deferredReason, legalityOutcome.detail);
                    yield {
                        kind: "deferred",
                        envelope,
                        message,
                        reason: deferredReason,
                        sourceEpoch: Number(framedEpoch(message) ?? 0n),
                    };
                    continue;
                }
                if (legalityOutcome.kind === "violation") {
                    const { violation } = legalityOutcome;
                    log("commit envelope:%s rejected reason:%s detail:%s", envelopeLabel(envelope), violation.reason, violation.detail);
                    ctx.dedup.remember(message);
                    yield {
                        kind: "rejected",
                        result,
                        envelope,
                        message,
                        reason: violation.reason,
                        proofReason: violation.proofReason,
                        leafIndex: violation.leafIndex,
                    };
                    continue;
                }
                const disband = classifyDisbandCommit({
                    parentState,
                    resultingState: result.newState,
                    proposals: capturedCommit.proposals,
                    committerLeafIndex: capturedCommit.committerLeafIndex,
                });
                if (disband.kind === "validDisband") {
                    const digest = commitDigest(encode(mlsMessageEncoder, message));
                    ctx.admitDisbandCandidate(parentState, message, result.newState, {
                        commitDigest: digest,
                        actorPubkey: disband.actorPubkey,
                        sourceEpoch: Number(parentState.groupContext.epoch),
                        parentTag: bytesToHex(parentState.confirmationTag),
                        terminalOutcome: "disbanded",
                    });
                    continue;
                }
                ctx.setState(result.newState);
                // D-10/D-11: the commit's digest is computed once here and reused for
                // both the notification attribution below and the `removed` branch's
                // own attribution — never a second hashing path over the same bytes.
                const acceptedCommitDigest = commitDigest(encode(mlsMessageEncoder, message));
                const notifications = deriveStateNotifications({
                    parentState,
                    resultingState: result.newState,
                    commitDigest: acceptedCommitDigest,
                });
                // The commit removed *us* (an admin's Remove, or a peer committing our
                // own self_remove). State is now the `removedFromGroup` tombstone: no
                // secrets advanced, so nothing else in this batch can be decrypted and
                // retained history is moot. Surface it and stop the generator — there is
                // nothing left to process once we are out (member-departure.md).
                if (result.newState.groupActiveState.kind === "removedFromGroup") {
                    log("commit envelope:%s removed us from the group", envelopeLabel(envelope));
                    ctx.dedup.remember(message);
                    // D-10/D-12: the derived list always contains a `selfRemoved` entry
                    // on this branch (parent was active, resulting state is the
                    // tombstone), alongside `epochAdvanced` and this member's own
                    // `memberRemoved` entry, for the same commit.
                    ctx.recordStateNotifications(acceptedCommitDigest, Number(result.newState.groupContext.epoch), notifications);
                    yield {
                        kind: "removed",
                        result,
                        envelope,
                        message,
                        notifications,
                    };
                    return;
                }
                ctx.recordCommit(parentState, message, result.newState);
                ctx.recordStateNotifications(acceptedCommitDigest, Number(result.newState.groupContext.epoch), notifications);
                ctx.dedup.remember(message);
                log("commit envelope:%s applied – new epoch:%d", envelopeLabel(envelope), ctx.getState().groupContext.epoch);
                yield { kind: "processed", result, envelope, message, notifications };
            }
        }
        catch (error) {
            if (isPermanentDecryptFailure(error)) {
                log("commit permanently unreadable envelope:%s – %s", envelopeLabel(envelope), error.message);
                yield { kind: "unreadable", envelope, errors: [error] };
                continue;
            }
            log("commit failed envelope:%s – queued for retry: %O", envelopeLabel(envelope), error);
            errorList.push({ envelope, error });
            unreadable.push(envelope);
        }
    }
    if (forkPool.length > 0) {
        const retainedPool = forkPool.filter((p) => ctx.retained.hasState(p.epoch));
        const orphanPool = forkPool.filter((p) => !ctx.retained.hasState(p.epoch));
        if (retainedPool.length > 0) {
            const minForkEpoch = Math.min(...retainedPool.map((p) => p.epoch));
            const resolution = await ctx.resolveFork(minForkEpoch, retainedPool.map((p) => p.message), decryptFailed, envelopes);
            // WR-01: a pool candidate refused at its own parent (admin policy or
            // commit legality) is reported `rejected` with the same reason labels
            // as the direct inbound commit seam above — never `past-epoch`, which
            // would claim it was already applied.
            const rejectedByDigest = new Map();
            for (const candidate of resolution.rejected ?? [])
                rejectedByDigest.set(bytesToHex(commitDigest(encode(mlsMessageEncoder, candidate.message))), candidate);
            const livePool = [];
            for (const p of retainedPool) {
                const refused = rejectedByDigest.get(bytesToHex(commitDigest(encode(mlsMessageEncoder, p.message))));
                if (!refused) {
                    livePool.push(p);
                    continue;
                }
                const reason = refused.violation?.reason ?? "admin-policy";
                log("fork candidate envelope:%s rejected reason:%s", envelopeLabel(p.envelope), reason);
                ctx.dedup.remember(p.message);
                yield {
                    kind: "rejected",
                    result: refused.result,
                    envelope: p.envelope,
                    message: p.message,
                    reason,
                    proofReason: refused.violation?.proofReason,
                    leafIndex: refused.violation?.leafIndex,
                };
            }
            if (resolution.outcome === "recovered") {
                log("convergence rewound to canonical branch – epoch:%d", ctx.getState().groupContext.epoch);
                const rep = livePool[0];
                // The canonical branch we rewound onto may itself have removed us; the
                // winning tip is now live state, so report `removed` rather than
                // `processed` (member-departure.md). The rewind's `invalidated`
                // retractions below are still reported — they are independent.
                if (!rep) {
                    // WR-01: every triggering candidate was refused; the rewind was
                    // carried by other material, so there is no envelope to report it
                    // on. Surface the applied chain's notifications envelope-free, as
                    // the tree-fed rewind path (`#reconvergeFromTree`) does — otherwise
                    // they are ledger-recorded but never delivered.
                    //
                    // WR-04: the two terminal facts the sibling branches below carry —
                    // a selected disband and a rewind onto our own removal tombstone —
                    // ride along on each result, so a direct `./engine` consumer sees
                    // them without having to re-read engine state. The client layer
                    // still realizes both from state (`selectedDisbandEvidence`,
                    // `groupActiveState`), which is what covers the case where the
                    // rewind produced no notifications at all and therefore yields
                    // nothing here.
                    const removedFromGroup = ctx.getState().groupActiveState.kind === "removedFromGroup";
                    for (const group of groupWithdrawnNotificationsByCommit(resolution.notifications ?? []))
                        yield {
                            kind: "appliedNotifications",
                            commitDigest: group.commitDigest,
                            notifications: group.withdrawn,
                            selectedTerminal: resolution.selectedTerminal,
                            removedFromGroup,
                        };
                }
                else if (ctx.getState().groupActiveState.kind === "removedFromGroup") {
                    // D-10/D-12: attribute the derived notifications (including
                    // `selfRemoved`) to the winning branch's OWN tip commit, not
                    // `rep.message` (which is merely the first forkPool entry that
                    // triggered this resolution) — the tip commit is the one that
                    // actually produced the tombstone. `resolution.notifications` is
                    // derived (and ledger-recorded) by `#applyForkResolution`, the same
                    // shared rewind-apply path the direct commit branch above uses.
                    //
                    // WR-18: `notifications` here spans the WHOLE applied winner chain,
                    // while `message` is only `rep.message`. This is the one place the
                    // per-commit reading of `ProcessedIngestResult`/`RemovedIngestResult`
                    // does not hold — consumers must attribute by each entry's
                    // `commitDigest`, as those types now document.
                    yield {
                        kind: "removed",
                        result: resolution.result,
                        envelope: rep.envelope,
                        message: rep.message,
                        notifications: resolution.notifications,
                    };
                }
                else {
                    yield {
                        kind: "processed",
                        result: resolution.result,
                        envelope: rep.envelope,
                        message: rep.message,
                        notifications: resolution.notifications,
                        selectedTerminal: resolution.selectedTerminal,
                    };
                }
                for (let i = 1; i < livePool.length; i++)
                    yield {
                        kind: "skipped",
                        envelope: livePool[i].envelope,
                        message: livePool[i].message,
                        reason: "past-epoch",
                    };
                // D-11: withdrawn state notifications are yielded BEFORE the
                // app-payload `invalidated` retractions below, so the two retraction
                // streams have a deterministic relative order within this drainable
                // generator.
                for (const group of groupWithdrawnNotificationsByCommit(resolution.withdrawnNotifications)) {
                    yield {
                        kind: "stateInvalidated",
                        commitDigest: group.commitDigest,
                        forkEpoch: minForkEpoch,
                        withdrawn: group.withdrawn,
                    };
                }
                // App payloads delivered on the now-abandoned branch are retracted (M7).
                for (const inv of resolution.invalidated) {
                    log("invalidate app payload envelope:%s", envelopeLabel(inv.envelope));
                    yield {
                        kind: "invalidated",
                        envelope: inv.envelope,
                        message: inv.message,
                        payload: inv.payload,
                        tag: inv.tag,
                        epoch: inv.epoch,
                    };
                }
            }
            else {
                for (const p of livePool)
                    yield {
                        kind: "skipped",
                        envelope: p.envelope,
                        message: p.message,
                        reason: "past-epoch",
                    };
            }
        }
        if (orphanPool.length > 0) {
            const currentTipEpoch = Number(ctx.getState().groupContext.epoch);
            const anchorEpoch = ctx.retained.anchorEpoch() ?? currentTipEpoch;
            for (const p of orphanPool) {
                if (p.epoch >= currentTipEpoch) {
                    yield {
                        kind: "skipped",
                        envelope: p.envelope,
                        message: p.message,
                        reason: "past-epoch",
                    };
                    continue;
                }
                const outcome = classifyLateCommit({
                    sourceEpoch: p.epoch,
                    anchorEpoch,
                    currentTipEpoch,
                    maxRewindCommits: ctx.maxRewindCommits,
                    parentArrived: true,
                    retainedParentStateAvailable: false,
                });
                if (outcome.kind === "missing_retained_anchor") {
                    ctx.toUnrecoverable();
                    log("convergence lost retained anchor – group is Unrecoverable");
                    yield {
                        kind: "skipped",
                        envelope: p.envelope,
                        message: p.message,
                        reason: "missing-retained-anchor",
                    };
                }
                else if (outcome.kind === "beyond_anchor") {
                    yield {
                        kind: "skipped",
                        envelope: p.envelope,
                        message: p.message,
                        reason: "beyond-anchor",
                    };
                }
                else {
                    yield {
                        kind: "skipped",
                        envelope: p.envelope,
                        message: p.message,
                        reason: "past-epoch",
                    };
                }
            }
        }
    }
    log("done processing batch – epoch:%d", ctx.getState().groupContext.epoch);
    if (unreadable.length === 0) {
        log("done – no unreadable envelopes remain");
        return;
    }
    // A retry only helps when something applied this pass (e.g. a commit advanced
    // the epoch, unlocking an out-of-order message). If the pass made no progress,
    // the same envelopes against the same state would fail identically — so yield
    // them now instead of spinning to maxRetries.
    if (ctx.getState() === stateBeforePass) {
        log("no progress this pass – yielding %d envelope(s) as deferred/unreadable", unreadable.length);
        for (const envelope of unreadable) {
            yield terminalResult(envelope, deferred, errorList, decryptFailedAll);
        }
        return;
    }
    log("scheduling retry for %d unreadable envelope(s)", unreadable.length);
    yield* ingestEnvelopes(ctx, unreadable, {
        retryCount: retryCount + 1,
        maxRetries,
        _errors: errorList,
        _deferred: deferred,
        _decryptFailed: decryptFailedAll,
    });
}
