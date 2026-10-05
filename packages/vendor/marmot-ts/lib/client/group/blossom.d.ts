import type { EventSigner } from "applesauce-core/factories";
/**
 * Minimal Blossom (BUD-01 GET / BUD-02 upload) HTTP helpers for encrypted
 * media, mirroring MDK `marmot-app/src/media/blossom.rs`. They move opaque
 * ciphertext only; encryption and integrity live in `core/media`.
 *
 * The `fetch` implementation is injectable so tests and non-standard runtimes
 * can supply their own; it defaults to the global `fetch`.
 */
/** A `fetch`-compatible function. */
export type FetchLike = (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
}>;
/**
 * Builds the `Authorization: Nostr <base64url(event)>` header for a Blossom
 * upload of the blob with hash `hashHex` to `server` (kind 24242,
 * `t=upload`, `expiration`, `x=<hash>`, `server=<host>`), signed by `signer`.
 * Encoded with unpadded base64url like MDK.
 */
export declare function createBlossomUploadAuthorization(signer: EventSigner, server: string, hashHex: string, now?: number): Promise<string>;
export type UploadBlossomBlobOptions = {
    /** Blossom server base URL (e.g. a policy `default_blob_endpoints` entry). */
    server: string;
    /** The ciphertext to upload. */
    blob: Uint8Array;
    /** Signs the BUD-02 upload authorization. */
    signer: EventSigner;
    fetch?: FetchLike;
};
/**
 * Uploads `blob` to one Blossom server and returns the blob URL to use as a
 * `blossom-v1` locator. The server's descriptor `url` is used when present and
 * must commit to the blob hash; otherwise the spec fallback URL
 * (`server_root/<hash>`) is returned.
 *
 * @throws When the server rejects the upload or returns a descriptor for a
 *   different blob.
 */
export declare function uploadBlossomBlob(options: UploadBlossomBlobOptions): Promise<string>;
/**
 * Uploads `blob` to each server in order until one succeeds (MDK
 * `upload_blossom_blob_with_fallback`). Returns the locator URL and the server
 * that accepted it.
 *
 * @throws An aggregate error when every server fails.
 */
export declare function uploadBlossomBlobWithFallback(options: Omit<UploadBlossomBlobOptions, "server"> & {
    servers: string[];
}): Promise<{
    url: string;
    server: string;
}>;
/**
 * Fetches candidate URLs in order and returns the first body whose SHA-256
 * equals `expectedSha256Hex`. Candidates come from `resolveMediaFetchUrls`,
 * which already applied group policy and destination safety.
 *
 * @throws When no candidate yields matching bytes.
 */
export declare function fetchBlossomBlob(candidates: readonly string[], expectedSha256Hex: string, opts?: {
    fetch?: FetchLike;
}): Promise<Uint8Array>;
