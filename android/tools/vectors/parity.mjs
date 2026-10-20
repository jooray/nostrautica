// Accept/reject parity vectors: payloads and tags at the edges of the protocol's
// bounds, with the TypeScript package's verdict on each, so the Kotlin port is
// checked against the reference rather than against its own reading of it
// (audit SB-72..85). Deterministic: re-running on an unchanged protocol package
// rewrites the same file.
//   pnpm --filter @nostrautica/protocol build && node android/tools/vectors/parity.mjs
// writes android/protocol/src/test/resources/parity-vectors.json.
// PROTOCOL_DIST=<dir> points it at another build of packages/protocol/dist.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = process.env.PROTOCOL_DIST
  ? pathToFileURL(process.env.PROTOCOL_DIST.replace(/\/?$/, "/"))
  : new URL("../../../packages/protocol/dist/", import.meta.url);
const P = await import(new URL("index.js", dist));

const pk = "e0".repeat(32);
const hex = (b) => b.repeat(32);
const coord = `31923:${pk}:plan-b`;
const eckKey = Buffer.alloc(32, 7).toString("base64");
const n = (k, f) => Array.from({ length: k }, (_, i) => f(i));
const long = (k) => "x".repeat(k);

// ── Payloads: [schema, label, payload] ────────────────────────────────────
const payloads = [];
const add = (schema, label, payload) => payloads.push({ schema, label, payload });

const page = (over) => ({ v: 2, sections: [{ type: "posts", source: "event", visibility: "public" }], ...over });
add("eventPageContent", "base", page({}));
add("eventPageContent", "posts source everyone", page({ sections: [{ type: "posts", source: "everyone", visibility: "public" }] }));
add("eventPageContent", "posts visibility x", page({ sections: [{ type: "posts", source: "event", visibility: "x" }] }));
add("eventPageContent", "pinned 50 refs", page({ sections: [{ type: "pinned", refs: n(50, (i) => `naddr1${i}`) }] }));
add("eventPageContent", "pinned 51 refs", page({ sections: [{ type: "pinned", refs: n(51, (i) => `naddr1${i}`) }] }));
add("eventPageContent", "pinned ref 2049 chars", page({ sections: [{ type: "pinned", refs: [long(2049)] }] }));
add("eventPageContent", "50 sections", page({ sections: n(50, () => ({ type: "attendees" })) }));
add("eventPageContent", "51 sections", page({ sections: n(51, () => ({ type: "attendees" })) }));
const feed = (over) => page({ sources: [{ pubkey: pk, ...over }] });
add("eventPageContent", "feed base", feed({ tags: ["a"], since: 0, until: 5, relays: ["wss://r"], label: "L" }));
add("eventPageContent", "feed label 201", feed({ label: long(201) }));
add("eventPageContent", "feed 11 tags", feed({ tags: n(11, (i) => `t${i}`) }));
add("eventPageContent", "feed tag 101", feed({ tags: [long(101)] }));
add("eventPageContent", "feed 31 relays", feed({ relays: n(31, (i) => `wss://r${i}`) }));
add("eventPageContent", "feed since -1", feed({ since: -1 }));
add("eventPageContent", "feed bad pubkey", feed({ pubkey: "zz" }));

const priv = (over) => ({ v: 2, menu: [{ label: "L", target: "https://x", pos: 0 }], sections: [{ type: "attendees", pos: 1 }], ...over });
add("eventPagePrivate", "base", priv({}));
add("eventPagePrivate", "section without pos", priv({ sections: [{ type: "attendees" }] }));
add("eventPagePrivate", "menu without pos", priv({ menu: [{ label: "L", target: "https://x" }] }));
add("eventPagePrivate", "negative pos", priv({ sections: [{ type: "attendees", pos: -1 }] }));
add("eventPagePrivate", "menu label 201", priv({ menu: [{ label: long(201), target: "https://x", pos: 0 }] }));
add("eventPagePrivate", "menu target 2049", priv({ menu: [{ label: "L", target: long(2049), pos: 0 }] }));
add("eventPagePrivate", "pinned 51 refs", priv({ sections: [{ type: "pinned", refs: n(51, (i) => `r${i}`), pos: 0 }] }));

const roster = (key) => ({ v: 2, eck_current: 1, attendees: [{ pubkey: pk, d: "d1", role: "attendee", chat_keys: [{ pubkey: hex("ab"), added_at: 1, ...key }] }] });
add("rosterContent", "chat key plain", roster({}));
add("rosterContent", "chat key external true", roster({ external: true }));
add("rosterContent", "chat key external false", roster({ external: false }));

const ai = { summary: "S", skills: [], interests: ["x"], offers: [], seeks: [] };
const dir = (aiProfile) => ({ v: 2, pubkey: pk, profile: {}, ai_profile: aiProfile, updated_at: 1 });
add("directoryEntryContent", "ai base", dir(ai));
add("directoryEntryContent", "ai without interests", dir({ summary: "S", skills: [], offers: [], seeks: [] }));
add("directoryEntryContent", "ai translations ok", dir({ ...ai, translations: { lang: "sk", about: "a", looking_for: "b", skills: ["c"] } }));
add("directoryEntryContent", "ai translations about 5001", dir({ ...ai, translations: { lang: "sk", about: long(5001) } }));
add("directoryEntryContent", "ai translations lang 36", dir({ ...ai, translations: { lang: long(36) } }));

const corr = (over) => ({ v: 2, a: coord, rev: 1, ...over });
add("profileCorrectionContent", "base", corr({ overrides: { summary: "s", skills: ["a"] }, hidden_fields: ["summary"] }));
add("profileCorrectionContent", "override summary 5001", corr({ overrides: { summary: long(5001) } }));
add("profileCorrectionContent", "override 51 skills", corr({ overrides: { skills: n(51, (i) => `s${i}`) } }));
add("profileCorrectionContent", "hidden_fields 5", corr({ hidden_fields: ["summary", "skills", "interests", "offers", "seeks"] }));
add("profileCorrectionContent", "hidden_fields 6 (repeat)", corr({ hidden_fields: ["summary", "skills", "interests", "offers", "seeks", "summary"] }));

const grant = (over) => ({ v: 2, a: coord, role: "attendee", eck: [{ id: 1, key: eckKey }], granted_by: pk, ...over });
const parent = { a: `31612:${pk}:c`, by: pk, sig: "ab".repeat(64) };
add("keyGrantContent", "base", grant({}));
add("keyGrantContent", "with parent", grant({ parent }));
add("keyGrantContent", "parent short sig", grant({ parent: { ...parent, sig: "ab" } }));
add("keyGrantContent", "parent bad by", grant({ parent: { ...parent, by: "zz" } }));
add("keyGrantContent", "parent a 2049", grant({ parent: { ...parent, a: long(2049) } }));
add("keyGrantContent", "eck 1024", grant({ eck: n(1024, (i) => ({ id: i + 1, key: eckKey })) }));
add("keyGrantContent", "eck 1025", grant({ eck: n(1025, (i) => ({ id: i + 1, key: eckKey })) }));

const ann = (over) => ({ v: 2, name: "C", ...over });
add("coordinatorAnnounce", "base", ann({ relays: ["wss://r"], features: { chat: ["marmot"] }, privacy: { llm: "private" },
  pricing: { model: "free", free_up_to_users: 0, summary: "s", checkout_url: "https://pay.example", currency: "EUR" } }));
add("coordinatorAnnounce", "pricing model crypto", ann({ pricing: { model: "crypto" } }));
add("coordinatorAnnounce", "free_up_to_users -1", ann({ pricing: { model: "free", free_up_to_users: -1 } }));
add("coordinatorAnnounce", "pricing summary 281", ann({ pricing: { model: "free", summary: long(281) } }));
add("coordinatorAnnounce", "checkout http", ann({ pricing: { model: "free", checkout_url: "http://pay.example" } }));
add("coordinatorAnnounce", "currency 17", ann({ pricing: { model: "free", currency: long(17) } }));
add("coordinatorAnnounce", "operator 201", ann({ operator: long(201) }));
add("coordinatorAnnounce", "31 relays", ann({ relays: n(31, (i) => `wss://r${i}`) }));
add("coordinatorAnnounce", "31 chat", ann({ features: { chat: n(31, (i) => `c${i}`) } }));
add("coordinatorAnnounce", "32 privacy roles", ann({ privacy: Object.fromEntries(n(32, (i) => [`r${i}`, "p"])) }));
add("coordinatorAnnounce", "33 privacy roles", ann({ privacy: Object.fromEntries(n(33, (i) => [`r${i}`, "p"])) }));
add("coordinatorAnnounce", "privacy role 65", ann({ privacy: { [long(65)]: "p" } }));
add("coordinatorAnnounce", "privacy tier 201", ann({ privacy: { llm: long(201) } }));
add("coordinatorAnnounce", "name empty", ann({ name: "" }));

add("myProfileContent", "base", { v: 2, a: coord, rev: 0, correction_rev: 0 });
add("myProfileContent", "library entry a null", { v: 2, a: null, media: [] });
add("myProfileContent", "a missing", { v: 2, media: [] });
add("myProfileContent", "rev -1", { v: 2, a: coord, rev: -1 });
add("myProfileContent", "correction_rev -1", { v: 2, a: coord, correction_rev: -1 });

const backup = (over) => ({ v: 2, a: coord, eid_nsec: hex("01"), einbox_nsec: hex("02"), eck: [{ id: 1, key: eckKey }], ...over });
add("eventKeysBackup", "base", backup({ coordinator_gen: 0 }));
add("eventKeysBackup", "coordinator_gen -1", backup({ coordinator_gen: -1 }));
add("eventKeysBackup", "eck 1025", backup({ eck: n(1025, (i) => ({ id: i + 1, key: eckKey })) }));

const talk = (over) => ({ v: 2, a: coord, talk_d: "t1", title: "T", external_url: "https://youtu.be/x", external_kind: "youtube", ...over });
add("talkSubmissionContent", "base", talk({}));
add("talkSubmissionContent", "50 speakers", talk({ speakers: n(50, () => pk) }));
add("talkSubmissionContent", "51 speakers", talk({ speakers: n(51, () => pk) }));

for (const p of payloads) p.ok = P[`${p.schema}Schema`].safeParse(p.payload).success;

// ── 31600 tags: the v tag, the coordinator generation, relay URL filters ───
const configs = [];
const cfgTags = (extra) => [["d", "x"], ["inbox", hex("ab")], ...extra];
const cfg = (label, extra) => {
  const tags = cfgTags(extra);
  let parsed = null;
  try {
    const c = P.parseEventConfig(pk, tags);
    parsed = { coordinator: c.coordinator ?? null, coordinatorGen: c.coordinatorGen ?? null, relays: c.relays, chatRelays: c.chatRelays };
  } catch {
    parsed = null;
  }
  configs.push({ label, tags, parsed });
};
for (const v of ["2", "2.0", " 2 ", "+2", "2e0", "0x2", "02", "2.5", "", "two"]) cfg(`v=${JSON.stringify(v)}`, [["v", v]]);
for (const g of ["3", "3.0", " 3", "0x3", "3e0", "0", "-1", "1.5", "", "x"]) cfg(`gen=${JSON.stringify(g)}`, [["v", "2"], ["coordinator", hex("cd"), g]]);
cfg("relay spellings", [["v", "2"],
  ["relay", "wss://nos.lol"], ["relay", "WSS://Relay.Example.com"], ["relay", "wss:foo"], ["relay", "ws://plain"],
  ["relay", "https://not-a-relay"], ["relay", "wss://"], ["relay", "nonsense"], ["relay", "WSS://RELAY.EU.WHITENOISE.CHAT"],
  ["chat_relay", "Wss://chat.example"], ["chat_relay", "wss:chat2"]]);

// ── Coordinates ───────────────────────────────────────────────────────────
const coordinates = [`31923:${pk}:d`, `031923:${pk}:d`, `+31923:${pk}:d`, `31923.0:${pk}:d`, ` 31923:${pk}:d`, `:${pk}:d`,
  `0:${pk}:d`, `65536:${pk}:d`, `31923:${pk.toUpperCase()}:d`, `31923:${pk}:a:b`].map((s) => {
  let ok = true;
  try { P.parseCoordinate(s); } catch { ok = false; }
  return { s, ok };
});

// ── The public 31608 menu ─────────────────────────────────────────────────
const menuTags = [["r", "https://a", "A"], ["r", long(2049), "too long"], ["r", "https://b"], ["r", "https://c", long(250)],
  ...n(60, (i) => ["r", `https://m${i}`, `M${i}`])];
const menu = { tags: menuTags, items: P.rTagsToMenu(menuTags) };

writeFileSync(new URL("../../protocol/src/test/resources/parity-vectors.json", import.meta.url),
  JSON.stringify({ payloads, configs, coordinates, menu }, null, 1) + "\n");
console.log(`wrote parity-vectors.json: ${payloads.length} payloads, ${configs.length} configs, ${coordinates.length} coordinates`);
