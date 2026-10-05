import { isLoopbackHost, rejectNonRoutableHost, } from "../components/host-safety.js";
import { BLOSSOM_LOCATOR_KIND, ENCRYPTED_MEDIA_VERSION_V2, } from "./types.js";
/** Locator kinds this client knows how to fetch. */
export const SUPPORTED_LOCATOR_KINDS = [
    BLOSSOM_LOCATOR_KIND,
];
const FETCH_URL_MAX_LEN = 2048;
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
 * The Blossom fallback fetch URL for a blob (`features/encrypted-media.md` —
 * Locator Kinds): `server_root || "/" || hash_hex`, where `server_root` is the
 * endpoint base URL with every trailing `/` removed. No extension, query, or
 * fragment is added.
 */
export function buildBlossomBlobUrl(baseUrl, hashHex) {
    return `${baseUrl.replace(/\/+$/, "")}/${hashHex.toLowerCase()}`;
}
/** The Blossom BUD-02 upload URL for an endpoint: `server_root || "/upload"`. */
export function buildBlossomUploadUrl(baseUrl) {
    return `${baseUrl.replace(/\/+$/, "")}/upload`;
}
/**
 * Extracts the content hash a Blossom URL commits to: the last 64-character
 * hex run in its path, lowercased (MDK `blossom_content_hash_from_url`).
 * Returns `undefined` when the URL does not parse or carries no such run.
 */
export function blossomContentHashFromUrl(url) {
    if (!URL.canParse(url))
        return undefined;
    const path = new URL(url).pathname;
    for (let end = path.length; end >= 64; end--) {
        const candidate = path.slice(end - 64, end);
        if (/^[0-9a-fA-F]{64}$/.test(candidate))
            return candidate.toLowerCase();
    }
    return undefined;
}
/**
 * Client destination policy for a Blossom fetch URL (MDK
 * `validate_blossom_fetch_url`): `https` to a public host, or `http` to a
 * loopback host when `allowLoopbackHttp` is set; no credentials or fragment.
 * A failing URL is skipped, never dialled — it does not invalidate the
 * reference that named it.
 */
export function isSafeBlossomFetchUrl(url, opts = {}) {
    if (!URL.canParse(url))
        return false;
    const parsed = new URL(url);
    if (parsed.href.length > FETCH_URL_MAX_LEN)
        return false;
    if (parsed.username !== "" || parsed.password !== "")
        return false;
    if (parsed.hash !== "" || parsed.href.includes("#"))
        return false;
    if (parsed.hostname === "")
        return false;
    if (parsed.protocol === "https:") {
        try {
            rejectNonRoutableHost(parsed.hostname, "blossom fetch URL");
            return true;
        }
        catch {
            return false;
        }
    }
    return (parsed.protocol === "http:" &&
        opts.allowLoopbackHttp === true &&
        isLoopbackHost(parsed.hostname));
}
/**
 * Builds backend-specific fallback fetch URLs from the policy's ordered
 * `default_blob_endpoints` and the attachment's `ciphertextSha256`
 * (`features/encrypted-media.md` — Locator Kinds). Endpoint order is the
 * fallback priority and is preserved.
 *
 * Only `blossom-v1` endpoints produce a URL (Blossom `GET /<sha256>`); other
 * kinds need backend-specific rules and are skipped. v2 attachments use the
 * spec's `server_root || "/" || hash` construction ({@link buildBlossomBlobUrl});
 * v1 attachments keep the frozen relative resolution against the base URL.
 */
export function buildFallbackFetchUrls(attachment, policy, opts = {}) {
    const supported = opts.supportedLocatorKinds ?? SUPPORTED_LOCATOR_KINDS;
    const urls = [];
    for (const endpoint of policy?.defaultBlobEndpoints ?? []) {
        if (endpoint.locatorKind !== BLOSSOM_LOCATOR_KIND)
            continue;
        if (!supported.includes(endpoint.locatorKind))
            continue;
        urls.push(attachment.version === ENCRYPTED_MEDIA_VERSION_V2
            ? buildBlossomBlobUrl(endpoint.baseUrl, attachment.ciphertextSha256)
            : // baseUrl is WHATWG-normalized (keeps a trailing `/`); join the hash.
                new URL(attachment.ciphertextSha256, endpoint.baseUrl).toString());
    }
    return urls;
}
/**
 * Resolves the ordered list of candidate fetch URLs for an attachment: explicit
 * supported+allowed `blossom-v1` locator URLs first, then policy fallback URLs.
 * Deduplicates while preserving order. A client tries them in order until one
 * yields bytes matching `ciphertextSha256`.
 *
 * For `encrypted-media-v2` attachments this also applies MDK's fetch-time
 * rules: when the group policy does not allow `blossom-v1` nothing is
 * fetchable; candidates that fail {@link isSafeBlossomFetchUrl} are skipped;
 * and a candidate whose URL does not commit to `ciphertextSha256`
 * ({@link blossomContentHashFromUrl}) is skipped as unfetchable. With no policy
 * (no encrypted-media component) `blossom-v1` is the allowed default.
 */
export function resolveMediaFetchUrls(attachment, policy, opts = {}) {
    const supported = opts.supportedLocatorKinds ?? SUPPORTED_LOCATOR_KINDS;
    const allowedLocatorKinds = opts.allowedLocatorKinds ??
        policy?.allowedLocatorKinds ?? [BLOSSOM_LOCATOR_KIND];
    const isV2 = attachment.version === ENCRYPTED_MEDIA_VERSION_V2;
    if (isV2 && !allowedLocatorKinds.includes(BLOSSOM_LOCATOR_KIND))
        return [];
    const explicit = selectFetchableLocators(attachment, {
        ...opts,
        allowedLocatorKinds,
        supportedLocatorKinds: supported,
    })
        .filter((l) => l.kind === BLOSSOM_LOCATOR_KIND)
        .map((l) => l.value);
    const fallback = buildFallbackFetchUrls(attachment, policy, opts);
    const expectedHash = attachment.ciphertextSha256.toLowerCase();
    const seen = new Set();
    const ordered = [];
    for (const url of [...explicit, ...fallback]) {
        if (seen.has(url))
            continue;
        seen.add(url);
        if (isV2) {
            if (!isSafeBlossomFetchUrl(url, opts))
                continue;
            if (blossomContentHashFromUrl(url) !== expectedHash)
                continue;
        }
        ordered.push(url);
    }
    return ordered;
}
