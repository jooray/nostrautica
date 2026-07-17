export interface HttpsUrlOptions {
    /** Maximum byte length of both the input and normalized URL. */
    maxLen: number;
    /** Allow `http` URLs that point at a loopback host (encrypted-media only). */
    allowLoopbackHttp?: boolean;
    /**
     * Trim surrounding whitespace from the input before parsing. The darkmatter
     * encrypted-media endpoint validator does this (`raw.trim()`); the avatar
     * validator does not.
     */
    trimInput?: boolean;
    /** Prefix used in thrown error messages. */
    label: string;
}
/**
 * Validates and normalizes an `https` (optionally loopback-`http`) URL the way
 * the darkmatter `validate_and_normalize_*` helpers do: no credentials, no
 * fragment, a routable host, and length bounds. Returns the WHATWG-normalized
 * URL. Both this and the Rust `url` crate implement the WHATWG URL Standard, so
 * normalized output matches across implementations for ordinary URLs.
 *
 * Note (darkmatter parity): query strings are accepted and preserved (#374 —
 * rejecting them forked commit acceptance), and the WHATWG trailing `/` is
 * kept, never stripped (the serializer's output is the stored form).
 */
export declare function validateAndNormalizeHttpsUrl(raw: string, opts: HttpsUrlOptions): string;
