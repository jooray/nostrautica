/**
 * Minimal in-memory Nostr relay (NIP-01) for e2e/screenshot runs on machines
 * without docker (docker/docker-compose.yml is the primary path). Supports
 * EVENT / REQ / CLOSE, filters (ids, kinds, authors, #tags, since, until,
 * limit), EOSE, OK, and live subscription fan-out. Replaceable-event pruning
 * is intentionally omitted — clients dedupe by created_at, and test runs are
 * short-lived. Not for production use.
 *
 * Usage: node e2e/local-infra/relay.mjs [port]   (default 7777)
 */
import { WebSocketServer } from "ws";

const PORT = Number(process.argv[2] ?? 7777);
const events = []; // append-only
const subs = new Map(); // ws -> Map<subId, filters[]>

function matches(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith("#")) continue;
    const tag = k.slice(1);
    const values = ev.tags.filter((t) => t[0] === tag).map((t) => t[1]);
    if (!v.some((x) => values.includes(x))) return false;
  }
  return true;
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  subs.set(ws, new Map());
  ws.on("close", () => subs.delete(ws));
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const [type, ...rest] = msg;
    if (type === "EVENT") {
      const ev = rest[0];
      if (!ev?.id || !ev?.sig) return ws.send(JSON.stringify(["OK", ev?.id ?? "", false, "invalid"]));
      if (!events.some((e) => e.id === ev.id)) events.push(ev);
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      for (const [client, clientSubs] of subs) {
        if (client.readyState !== 1) continue;
        for (const [subId, filters] of clientSubs) {
          if (filters.some((f) => matches(ev, f))) {
            client.send(JSON.stringify(["EVENT", subId, ev]));
          }
        }
      }
    } else if (type === "REQ") {
      const [subId, ...filters] = rest;
      subs.get(ws)?.set(subId, filters);
      // NIP-01: `limit` applies PER FILTER, and the response is the union of
      // all filters' matches (deduped). The old Math.min-across-filters logic
      // let one `limit:1` filter in an NDK-grouped REQ starve every other
      // filter — backdated gift-wrap grants were never returned (found via
      // e2e, TEST-REPORT-2026-07-13).
      const ordered = [...events].sort((a, b) => b.created_at - a.created_at);
      const sentIds = new Set();
      for (const f of filters) {
        let n = 0;
        const lim = f.limit ?? Infinity;
        for (const ev of ordered) {
          if (n >= lim) break;
          if (!matches(ev, f)) continue;
          n++;
          if (!sentIds.has(ev.id)) {
            sentIds.add(ev.id);
            ws.send(JSON.stringify(["EVENT", subId, ev]));
          }
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    } else if (type === "CLOSE") {
      subs.get(ws)?.delete(rest[0]);
    }
  });
});

console.log(`[local-relay] ws://localhost:${PORT} (in-memory, ${events.length} events)`);
