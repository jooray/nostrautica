/**
 * TLS-terminating passthrough for the local Nostr relay (chat/full tiers) —
 * an stunnel-style byte pipe, NOT a WebSocket-frame proxy.
 *
 * Why this exists (mirrors the https-Blossom proxy, gotcha #2): the protocol's
 * `parseEventConfig` keeps only `wss://` relay tags (SSRF hardening — `urlValues(…,
 * "relay", "wss:")`), so a plain `ws://127.0.0.1:7777` relay is dropped from
 * `ctx.config.relays`. Marmot group chat publishes its kind-30443 key package to
 * `ctx.config.relays` ONLY (no fallback), so with an empty list it throws "At least
 * one relay URL is required to publish a key package" and the chat session never
 * starts. Fronting the relay with a self-signed `wss://` origin makes the config
 * carry a wss URL the chat client (and everything else) can use.
 *
 * Why byte-pipe and not a `ws`-library proxy: a frame-level proxy re-parses every
 * WebSocket frame and manages a separate backend socket per client, which raced
 * enough to intermittently drop a just-published event (a kind-0 profile that never
 * reached the relay → flaky `newUser`). This instead TLS-terminates and pipes the
 * DECRYPTED bytes straight to a TCP socket on the backend relay: the browser's TLS
 * handshake + HTTP Upgrade + every WS frame pass through untouched, exactly as
 * stunnel would, so nothing is buffered, re-framed, or dropped.
 *
 * Terminates TLS on PROXY_LISTEN_PORT and pipes to 127.0.0.1:BACKEND_PORT (nak /
 * the in-repo relay). Throwaway cert from /tmp/nostrautica-tls (shared w/ Blossom).
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:tls";
import { connect } from "node:net";

const LISTEN = Number(process.env.PROXY_LISTEN_PORT ?? 7778);
const BACKEND = Number(process.env.BACKEND_PORT ?? 7777);
const TLS_DIR = process.env.TLS_DIR ?? "/tmp/nostrautica-tls";

const server = createServer(
  {
    key: readFileSync(`${TLS_DIR}/key.pem`),
    cert: readFileSync(`${TLS_DIR}/cert.pem`),
  },
  (tlsSocket) => {
    const backend = connect(BACKEND, "127.0.0.1");
    // Full-duplex raw byte passthrough. `pipe` handles backpressure; a half-close
    // on either side tears down both.
    tlsSocket.pipe(backend);
    backend.pipe(tlsSocket);
    const destroyBoth = () => {
      tlsSocket.destroy();
      backend.destroy();
    };
    tlsSocket.on("error", destroyBoth);
    backend.on("error", destroyBoth);
    tlsSocket.on("close", () => backend.destroy());
    backend.on("close", () => tlsSocket.destroy());
  },
);

server.on("error", (e) => console.error("[wss-relay-proxy] server error", e));
server.listen(LISTEN, "127.0.0.1", () => {
  console.log(`[wss-relay-proxy] wss://localhost:${LISTEN} -> tcp://127.0.0.1:${BACKEND} (TLS passthrough)`);
});

const shutdown = () => {
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
