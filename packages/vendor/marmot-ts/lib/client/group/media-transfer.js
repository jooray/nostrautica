import { encodeMediaImetaTag, parseMediaImetaTag, getMediaAttachments, resolveMediaFetchUrls, StaleMediaPreparationError, } from "../../core/media.js";
import { getEncryptedMediaPolicy } from "../../core/components/dictionary.js";
import { createChatRumor, createApplicationMessageIntent, } from "./application-message.js";
function limits(options, closedSignal) {
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(maxBytes) ||
        maxBytes < 16 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0)
        throw new Error("Invalid media transfer limits");
    return {
        maxBytes,
        signal: AbortSignal.any([
            closedSignal,
            ...(options.signal ? [options.signal] : []),
            AbortSignal.timeout(timeoutMs),
        ]),
    };
}
async function cancellable(signal, task) {
    signal.throwIfAborted();
    let abort;
    const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([task(), cancelled]);
    }
    finally {
        signal.removeEventListener("abort", abort);
    }
}
function policyFor(group) {
    group.session.assertOutboundOpen();
    const policy = getEncryptedMediaPolicy(group.state.groupContext.extensions);
    if (!policy)
        throw new Error("Encrypted media v2 is not enabled for this group");
    return policy;
}
/** Upload all attachments and build one guarded kind-9 send intent. No MLS mutation. */
export async function prepareMediaMessage(group, files, options) {
    const policy = policyFor(group);
    if (!files.length)
        throw new Error("At least one media attachment is required");
    if (options.tags?.some((tag) => tag[0] === "imeta"))
        throw new Error("Pass attachments as files, not additional imeta tags");
    const expectedParent = group.session.parentToken;
    const { signal, maxBytes } = limits(options, group.closedSignal);
    const attachments = [];
    for (const { blob, metadata } of files) {
        signal.throwIfAborted();
        if (blob.size + 16 > maxBytes)
            throw new Error("Media upload exceeds byte limit");
        const prepared = await group.encryptMedia(blob, metadata);
        if (prepared.expectedParent !== expectedParent)
            throw new StaleMediaPreparationError();
        let lastError;
        for (const endpoint of policy.defaultBlobEndpoints) {
            if (endpoint.locatorKind !== "blossom-v1" ||
                !policy.allowedLocatorKinds.includes(endpoint.locatorKind))
                continue;
            group.session.assertOutboundOpen();
            if (group.session.parentToken !== expectedParent)
                throw new StaleMediaPreparationError();
            try {
                const value = await cancellable(signal, () => options.transport.upload({
                    baseUrl: endpoint.baseUrl,
                    data: prepared.encrypted,
                    ciphertextSha256: prepared.attachment.ciphertextSha256,
                    signal,
                    maxBytes,
                }));
                const attachment = {
                    ...prepared.attachment,
                    locators: [{ kind: "blossom-v1", value }],
                };
                encodeMediaImetaTag(attachment);
                prepared.attachment = attachment;
                lastError = undefined;
                break;
            }
            catch (error) {
                lastError = error;
                signal.throwIfAborted();
            }
        }
        if (!prepared.attachment.locators.length)
            throw lastError ?? new Error("No usable media upload endpoint");
        attachments.push(prepared.attachment);
    }
    signal.throwIfAborted();
    group.session.assertOutboundOpen();
    if (group.session.parentToken !== expectedParent)
        throw new StaleMediaPreparationError();
    const pubkey = await group.signer.getPublicKey();
    const rumor = createChatRumor({
        pubkey,
        content: options.caption ?? "",
        tags: [...(options.tags ?? []), ...attachments.map(encodeMediaImetaTag)],
    });
    return {
        rumor,
        attachments,
        intent: {
            ...createApplicationMessageIntent(rumor),
            expectedParent,
            ...(options.signal ? { signal: options.signal } : {}),
        },
    };
}
/** Fetch and decrypt exactly one reference; try fallbacks after corrupt blobs too. */
export async function downloadMediaAttachment(group, attachment, sourceParent, options) {
    if (!parseMediaImetaTag(encodeMediaImetaTag(attachment)))
        throw new Error("Invalid media attachment");
    const { signal, maxBytes } = limits(options, group.closedSignal);
    const tried = new Set();
    let lastError;
    for (;;) {
        signal.throwIfAborted();
        // Every contact decision uses current policy, including after a failed
        // fetch yields to an inbound policy replacement/removal.
        const policy = policyFor(group);
        const url = resolveMediaFetchUrls(attachment, policy).find((candidate) => !tried.has(candidate));
        if (!url)
            throw lastError ?? new Error("No fetchable media locator");
        tried.add(url);
        try {
            const data = await cancellable(signal, () => options.transport.fetch({ url, signal, maxBytes }));
            if (data.byteLength > maxBytes)
                throw new Error("Media download exceeds byte limit");
            const stored = await group.decryptMedia(data, attachment, sourceParent);
            signal.throwIfAborted();
            group.session.assertOutboundOpen();
            return stored;
        }
        catch (error) {
            lastError = error;
            signal.throwIfAborted();
        }
    }
}
/** Attachment failures are local; callers retain the original caption and tags. */
export async function downloadMessageMedia(group, tags, sourceParent, options) {
    return Promise.all(getMediaAttachments(tags).map(async (attachment) => {
        try {
            return {
                status: "ready",
                ...(await downloadMediaAttachment(group, attachment, sourceParent, options)),
            };
        }
        catch (error) {
            return { status: "unavailable", attachment, error };
        }
    }));
}
