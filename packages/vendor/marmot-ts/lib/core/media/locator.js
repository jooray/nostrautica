import { BLOSSOM_LOCATOR_KIND } from "./types.js";
/** Locator kinds this client knows how to fetch. */
export const SUPPORTED_LOCATOR_KINDS = [
    BLOSSOM_LOCATOR_KIND,
];
/**
 * Returns the attachment's locators that are fetchable right now: their kind is
 * supported by this client and (if a policy is supplied) allowed by the group.
 *
 * Fetchability is judged at fetch time against the group's CURRENT policy and
 * the client's current support, never against the source epoch
 * (`features/encrypted-media.md` — Validation). An unsupported/out-of-policy
 * locator is skipped, not treated as invalid. Order is preserved.
 */
export function selectFetchableLocators(attachment, opts = {}) {
    const supported = opts.supportedLocatorKinds ?? SUPPORTED_LOCATOR_KINDS;
    const allowed = opts.allowedLocatorKinds;
    return attachment.locators.filter((l) => supported.includes(l.kind) &&
        (allowed === undefined || allowed.includes(l.kind)));
}
/**
 * Builds backend-specific fallback fetch URLs from the policy's ordered
 * `default_blob_endpoints` and the attachment's `ciphertextSha256`
 * (`features/encrypted-media.md` — Locator Kinds). Endpoint order is the
 * fallback priority and is preserved.
 *
 * Only `blossom-v1` endpoints produce a URL (Blossom `GET /<sha256>`); other
 * kinds need backend-specific rules and are skipped. Whether to actually fetch
 * a loopback-`http` endpoint is a separate local dev/test decision.
 */
export function buildFallbackFetchUrls(attachment, policy, opts = {}) {
    const supported = opts.supportedLocatorKinds ?? SUPPORTED_LOCATOR_KINDS;
    const urls = [];
    for (const endpoint of policy.defaultBlobEndpoints) {
        if (endpoint.locatorKind !== BLOSSOM_LOCATOR_KIND)
            continue;
        if (!supported.includes(endpoint.locatorKind))
            continue;
        // baseUrl is WHATWG-normalized (keeps a trailing `/`); join the hash.
        urls.push(new URL(attachment.ciphertextSha256, endpoint.baseUrl).toString());
    }
    return urls;
}
/**
 * Resolves the ordered list of candidate fetch URLs for an attachment: explicit
 * supported+allowed `blossom-v1` locator URLs first, then policy fallback URLs.
 * Deduplicates while preserving order. A client tries them in order until one
 * yields bytes matching `ciphertextSha256`.
 */
export function resolveMediaFetchUrls(attachment, policy, opts = {}) {
    const supported = opts.supportedLocatorKinds ?? SUPPORTED_LOCATOR_KINDS;
    const explicit = selectFetchableLocators(attachment, {
        ...opts,
        allowedLocatorKinds: opts.allowedLocatorKinds ?? policy.allowedLocatorKinds,
        supportedLocatorKinds: supported,
    })
        .filter((l) => l.kind === BLOSSOM_LOCATOR_KIND)
        .map((l) => l.value);
    const fallback = buildFallbackFetchUrls(attachment, policy, opts);
    const seen = new Set();
    const ordered = [];
    for (const url of [...explicit, ...fallback]) {
        if (!seen.has(url)) {
            seen.add(url);
            ordered.push(url);
        }
    }
    return ordered;
}
//# sourceMappingURL=locator.js.map