// Minimal HTTPS -> HTTP reverse proxy so the local Blossom server (plain HTTP)
// satisfies the app's https-only media descriptor schema (audit C3 hardening).
// Not part of the product; a verification-pass-only shim.
import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const TARGET_PORT = process.env.PROXY_TARGET_PORT || 3000;
const LISTEN_PORT = process.env.PROXY_LISTEN_PORT || 8443;
// Same cert as the wss relay proxy; the orchestrator passes its TLS_DIR.
const TLS_DIR = process.env.TLS_DIR ?? "/tmp/nostrautica-tls";

const options = {
  key: fs.readFileSync(`${TLS_DIR}/key.pem`),
  cert: fs.readFileSync(`${TLS_DIR}/cert.pem`),
};

const server = https.createServer(options, (req, res) => {
  const proxyReq = http.request(
    { host: "localhost", port: TARGET_PORT, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(String(e));
  });
  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, () => console.log(`[https-proxy] https://localhost:${LISTEN_PORT} -> http://localhost:${TARGET_PORT}`));
