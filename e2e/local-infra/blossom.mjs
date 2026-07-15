/**
 * Minimal in-memory Blossom server (BUD-01/02/04/06) for e2e/screenshot runs
 * without docker. Stores blobs in memory, keyed by sha256; accepts any auth
 * (test-only — real Blossom verifies the kind-24242 event). Not for production.
 *
 * Usage: node e2e/local-infra/blossom.mjs [port]   (default 3000)
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv[2] ?? 3000);
// The app's media descriptor schema requires https:// blob URLs (audit C3
// hardening). When this plain-HTTP server sits behind a local TLS-terminating
// proxy (see _scratch_https_proxy.mjs), point BLOSSOM_PUBLIC_BASE_URL at the
// externally-reachable https origin so returned upload URLs validate.
const PUBLIC_BASE_URL = process.env.BLOSSOM_PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const blobs = new Map(); // sha256 -> { data, type }

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, PUT, OPTIONS");
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if ((req.method === "PUT" && path === "/upload") || (req.method === "PUT" && path === "/mirror")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const data = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const type = req.headers["content-type"] || "application/octet-stream";
      blobs.set(sha256, { data, type });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: `${PUBLIC_BASE_URL}/${sha256}`,
          sha256,
          size: data.length,
          type,
          uploaded: Math.floor(Date.now() / 1000),
        }),
      );
    });
    return;
  }

  if (req.method === "HEAD" && path === "/upload") return res.writeHead(200).end();

  const hash = path.slice(1).split(".")[0];
  if ((req.method === "GET" || req.method === "HEAD") && /^[0-9a-f]{64}$/.test(hash)) {
    const blob = blobs.get(hash);
    if (!blob) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": blob.type, "content-length": blob.data.length });
    return req.method === "HEAD" ? res.end() : res.end(blob.data);
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => console.log(`[local-blossom] http://localhost:${PORT} (in-memory)`));
