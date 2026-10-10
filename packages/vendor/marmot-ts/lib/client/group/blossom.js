/** @module @category Client - Group Media */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { blossomContentHashFromUrl, buildBlossomBlobUrl, buildBlossomUploadUrl, } from "../../core/media.js";
/** Lifetime of a Blossom upload authorization event (MDK: 10 minutes). */
const UPLOAD_AUTH_TTL_SECONDS = 10 * 60;
const UPLOAD_CONTENT_TYPE = "application/octet-stream";
function defaultFetch() {
    if (typeof fetch !== "function") {
        throw new Error("no global fetch available; pass a fetch implementation");
    }
    return fetch;
}
/**
 * Builds the `Authorization: Nostr <base64url(event)>` header for a Blossom
 * upload of the blob with hash `hashHex` to `server` (kind 24242,
 * `t=upload`, `expiration`, `x=<hash>`, `server=<host>`), signed by `signer`.
 * Encoded with unpadded base64url like MDK.
 */
export async function createBlossomUploadAuthorization(signer, server, hashHex, now = Math.floor(Date.now() / 1000)) {
    const host = new URL(server).hostname.toLowerCase();
    const event = await signer.signEvent({
        kind: 24242,
        content: "Upload Blob",
        created_at: now,
        tags: [
            ["t", "upload"],
            ["expiration", String(now + UPLOAD_AUTH_TTL_SECONDS)],
            ["x", hashHex],
            ["server", host],
        ],
    });
    return `Nostr ${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(event)))}`;
}
/**
 * Uploads `blob` to one Blossom server and returns the blob URL to use as a
 * `blossom-v1` locator. The server's descriptor `url` is used when present and
 * must commit to the blob hash; otherwise the spec fallback URL
 * (`server_root/<hash>`) is returned.
 *
 * @throws When the server rejects the upload or returns a descriptor for a
 *   different blob.
 */
export async function uploadBlossomBlob(options) {
    const doFetch = options.fetch ?? defaultFetch();
    const hashHex = bytesToHex(sha256(options.blob));
    const authorization = await createBlossomUploadAuthorization(options.signer, options.server, hashHex);
    const response = await doFetch(buildBlossomUploadUrl(options.server), {
        method: "PUT",
        headers: {
            Authorization: authorization,
            "Content-Type": UPLOAD_CONTENT_TYPE,
            "X-SHA-256": hashHex,
        },
        body: options.blob,
    });
    if (!response.ok) {
        throw new Error(`Blossom upload failed: HTTP ${response.status}`);
    }
    let descriptor = {};
    try {
        descriptor = JSON.parse(await response.text());
    }
    catch {
        throw new Error("Blossom upload returned an invalid descriptor");
    }
    if (typeof descriptor.sha256 === "string" &&
        descriptor.sha256.toLowerCase() !== hashHex) {
        throw new Error("Blossom upload descriptor hash did not match blob");
    }
    const url = typeof descriptor.url === "string" && descriptor.url.trim() !== ""
        ? descriptor.url
        : buildBlossomBlobUrl(options.server, hashHex);
    if (blossomContentHashFromUrl(url) !== hashHex) {
        throw new Error("Blossom upload descriptor URL did not commit to the blob");
    }
    return url;
}
/**
 * Uploads `blob` to each server in order until one succeeds (MDK
 * `upload_blossom_blob_with_fallback`). Returns the locator URL and the server
 * that accepted it.
 *
 * @throws An aggregate error when every server fails.
 */
export async function uploadBlossomBlobWithFallback(options) {
    if (options.servers.length === 0) {
        throw new Error("no Blossom upload endpoint available");
    }
    const failures = [];
    for (const server of options.servers) {
        try {
            return { url: await uploadBlossomBlob({ ...options, server }), server };
        }
        catch (err) {
            failures.push(`${new URL(server).host}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    throw new Error(`Blossom upload failed on every server (${failures.join("; ")})`);
}
/**
 * Fetches candidate URLs in order and returns the first body whose SHA-256
 * equals `expectedSha256Hex`. Candidates come from `resolveMediaFetchUrls`,
 * which already applied group policy and destination safety.
 *
 * @throws When no candidate yields matching bytes.
 */
export async function fetchBlossomBlob(candidates, expectedSha256Hex, opts = {}) {
    if (candidates.length === 0) {
        throw new Error("media reference has no fetchable locators");
    }
    const doFetch = opts.fetch ?? defaultFetch();
    const expected = expectedSha256Hex.toLowerCase();
    let lastError = "download failed";
    for (const url of candidates) {
        try {
            const response = await doFetch(url, { method: "GET" });
            if (!response.ok) {
                lastError = `HTTP ${response.status}`;
                continue;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytesToHex(sha256(bytes)) === expected)
                return bytes;
            lastError = "encrypted blob hash does not match media reference";
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
    }
    throw new Error(`encrypted media download failed: ${lastError}`);
}
