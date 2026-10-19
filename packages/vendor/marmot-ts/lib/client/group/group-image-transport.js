/** @module @category Client - Group Images */
import { base64urlnopad } from "@scure/base";
import { finalizeEvent, verifyEvent, } from "applesauce-core/helpers/event";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { rejectNonRoutableHost } from "../../core/components/host-safety.js";
export class GroupImageRequestError extends Error {
    reason;
    constructor(reason) {
        super(`Group image ${reason}`);
        this.reason = reason;
    }
}
/** Whole-blob fetch with no credentials, redirects, referrer or HTTP cache. */
export const fetchGroupImageTransport = async (request) => {
    validateGroupImageRequestUrl(request.url, request.method);
    validateGroupImageUploadRequest(request);
    const maxBytes = positiveLimit(request.maxBytes);
    const diagnosticBytes = positiveLimit(request.maxDiagnosticBytes ?? 1024);
    const deadlineMs = positiveLimit(request.deadlineMs, 2_147_483_647);
    const expiresAt = performance.now() + deadlineMs;
    if (request.signal.aborted)
        throw new GroupImageRequestError("cancelled");
    const controller = new AbortController();
    let reader;
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
        onAbort = () => {
            controller.abort();
            reject(new GroupImageRequestError("cancelled"));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
            controller.abort();
            reject(new GroupImageRequestError("deadline"));
        }, deadlineMs);
    });
    try {
        const response = await Promise.race([
            fetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body?.slice(),
                signal: controller.signal,
                redirect: "error",
                credentials: "omit",
                referrer: "",
                referrerPolicy: "no-referrer",
                cache: "no-store",
            }).then((response) => {
                // A noncooperative fetch can finish after the budget has already ended.
                if (controller.signal.aborted) {
                    void response.body?.cancel().catch(() => undefined);
                    throw new GroupImageRequestError("cancelled");
                }
                return response;
            }),
            interrupted,
        ]);
        if (performance.now() >= expiresAt) {
            void response.body?.cancel().catch(() => undefined);
            throw new GroupImageRequestError("deadline");
        }
        if (response.redirected || response.type === "opaqueredirect") {
            void response.body?.cancel().catch(() => undefined);
            throw new GroupImageRequestError("invalid-response");
        }
        if (!response.body)
            throw new GroupImageRequestError("invalid-response");
        reader = response.body.getReader();
        const byteLimit = response.status >= 200 && response.status < 300
            ? maxBytes
            : Math.min(maxBytes, diagnosticBytes);
        const length = response.headers.get("content-length");
        if (length !== null) {
            if (!/^\d+$/.test(length))
                throw new GroupImageRequestError("invalid-response");
            if (!Number.isSafeInteger(Number(length)) || Number(length) > byteLimit)
                throw new GroupImageRequestError("byte-limit");
        }
        // Geometric growth also bounds metadata overhead for millions of tiny chunks.
        let body = new Uint8Array(Math.min(byteLimit, 64 * 1024));
        let size = 0;
        while (true) {
            const { done, value } = await Promise.race([reader.read(), interrupted]);
            if (performance.now() >= expiresAt)
                throw new GroupImageRequestError("deadline");
            if (done)
                break;
            if (!(value instanceof Uint8Array))
                throw new GroupImageRequestError("invalid-response");
            if (value.length > byteLimit - size)
                throw new GroupImageRequestError("byte-limit");
            if (size + value.length > body.length) {
                const grown = new Uint8Array(Math.min(byteLimit, Math.max(size + value.length, body.length * 2)));
                grown.set(body.subarray(0, size));
                body = grown;
            }
            body.set(value, size);
            size += value.length;
        }
        return { status: response.status, body: body.slice(0, size) };
    }
    finally {
        // Do not await untrusted underlying-source cancellation.
        if (reader) {
            void reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
        if (timer)
            clearTimeout(timer);
        if (onAbort)
            request.signal.removeEventListener("abort", onAbort);
        controller.abort();
    }
};
function positiveLimit(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new GroupImageRequestError("byte-limit");
    return value;
}
/** Validate before policy or transport; only origin-root profile paths contact HTTP. */
export function validateGroupImageRequestUrl(value, method) {
    try {
        if (method !== "GET" && method !== "PUT")
            throw new Error();
        const url = new URL(value);
        normalizeGroupImageEndpoint(url.origin);
        if (url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (method === "PUT"
                ? url.pathname !== "/upload"
                : !/^\/[a-f0-9]{64}$/.test(url.pathname)))
            throw new Error();
    }
    catch {
        throw new GroupImageRequestError("contact-denied");
    }
}
export function normalizeGroupImageEndpoint(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.hash ||
            url.search ||
            url.pathname !== "/")
            throw new GroupImageRequestError("contact-denied");
        rejectNonRoutableHost(url.hostname, "Group image endpoint");
        return url.origin;
    }
    catch {
        throw new GroupImageRequestError("contact-denied");
    }
}
export function createGroupImageUploadAuthorization(endpoint, metadata) {
    endpoint = normalizeGroupImageEndpoint(endpoint);
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({
        kind: 24242,
        created_at: now - 1,
        content: "Upload Blob",
        tags: [
            ["t", "upload"],
            ["expiration", String(now + 600)],
            ["x", bytesToHex(metadata.imageHash)],
            ["server", new URL(endpoint).hostname.toLowerCase()],
        ],
    }, metadata.imageUploadKey);
    return `Nostr ${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(event)))}`;
}
/** Reject changed or broadened image credentials before any external contact. */
export function validateGroupImageUploadRequest(request) {
    if (request.method !== "PUT")
        return;
    try {
        const headers = Object.entries(request.headers);
        const normalized = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
        const authorization = normalized.get("authorization");
        const hash = normalized.get("x-sha-256");
        if (headers.length !== 3 ||
            normalized.size !== 3 ||
            normalized.get("content-type") !== "application/octet-stream" ||
            !hash ||
            !/^[a-f0-9]{64}$/.test(hash) ||
            !(request.body instanceof Uint8Array) ||
            request.body.length < 16 ||
            bytesToHex(sha256(request.body)) !== hash ||
            !authorization ||
            authorization.length > 8192 ||
            !/^Nostr [A-Za-z0-9_-]+$/.test(authorization))
            throw new Error();
        const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlnopad.decode(authorization.slice(6))));
        const now = Math.floor(Date.now() / 1000);
        const expiration = event.tags?.[1]?.[1];
        if (event.kind !== 24242 ||
            event.content !== "Upload Blob" ||
            !Number.isSafeInteger(event.created_at) ||
            event.created_at >= now ||
            event.created_at < now - 600 ||
            typeof expiration !== "string" ||
            !/^\d+$/.test(expiration) ||
            !Number.isSafeInteger(Number(expiration)) ||
            Number(expiration) <= now ||
            Number(expiration) > now + 600 ||
            Number(expiration) > event.created_at + 601 ||
            JSON.stringify(event.tags) !==
                JSON.stringify([
                    ["t", "upload"],
                    ["expiration", expiration],
                    ["x", hash],
                    ["server", new URL(request.url).hostname.toLowerCase()],
                ]) ||
            !verifyEvent(event))
            throw new Error();
    }
    catch {
        throw new GroupImageRequestError("invalid-response");
    }
}
export function validateGroupImageUploadResponse(response, endpoint, hash, size) {
    try {
        if (response.status !== 200 && response.status !== 201)
            throw new Error();
        const descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
        const url = new URL(descriptor.url);
        if (typeof descriptor.url !== "string" ||
            descriptor.sha256 !== hash ||
            !Number.isSafeInteger(descriptor.size) ||
            descriptor.size !== size ||
            descriptor.type !== "application/octet-stream" ||
            !Number.isSafeInteger(descriptor.uploaded) ||
            descriptor.uploaded < 0 ||
            url.origin !== endpoint ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !new RegExp(`^/${hash}(?:\\.[A-Za-z0-9]+)?$`).test(url.pathname))
            throw new Error();
    }
    catch {
        throw new GroupImageRequestError("invalid-response");
    }
}
