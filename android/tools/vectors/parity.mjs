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
add("eventKeysBackup", "pending_eck", backup({ pending_eck: [{ id: 2, key: eckKey }] }));
add("eventKeysBackup", "pending_eck bad key", backup({ pending_eck: [{ id: 2, key: "AAAA" }] }));
add("eventKeysBackup", "prior inboxes + co-organizers", backup({ prior_einbox_nsecs: [hex("03")], co_organizers: [hex("cc")] }));
add("eventKeysBackup", "33 co-organizers", backup({ co_organizers: n(33, () => hex("cc")) }));
const og = (over) => ({ v: 2, a: coord, eid_nsec: hex("01"), einbox_nsec: hex("02"), eck: [{ id: 1, key: eckKey }], config_relays: [], granted_by: pk, ...over });
add("organizerGrantContent", "base", og({}));
add("organizerGrantContent", "organizers + prior inboxes", og({ organizers: [pk, hex("cc")], prior_einbox_nsecs: [hex("03")] }));
add("organizerGrantContent", "organizer not hex", og({ organizers: ["zz"] }));
add("organizerGrantContent", "65 prior inboxes", og({ prior_einbox_nsecs: n(65, () => hex("03")) }));

// 21603 prev_coordinator (NIP §3.7, audit SB-122): optional, a lowercase hex pubkey when present.
const install = (over) => ({ v: 2, a: coord, gen: 2, inbox_nsec: hex("03"), eck: [{ id: 1, key: eckKey }], config_relays: [], ...over });
add("coordinatorGrantContent", "base (no prev_coordinator)", install({}));
add("coordinatorGrantContent", "prev_coordinator hex", install({ prev_coordinator: pk }));
add("coordinatorGrantContent", "prev_coordinator uppercase", install({ prev_coordinator: pk.toUpperCase() }));
add("coordinatorGrantContent", "prev_coordinator short", install({ prev_coordinator: pk.slice(2) }));
add("coordinatorGrantContent", "prev_coordinator npub", install({ prev_coordinator: "npub1" + "q".repeat(58) }));

const talk = (over) => ({ v: 2, a: coord, talk_d: "t1", title: "T", external_url: "https://youtu.be/x", external_kind: "youtube", ...over });
add("talkSubmissionContent", "base", talk({}));
add("talkSubmissionContent", "50 speakers", talk({ speakers: n(50, () => pk) }));
add("talkSubmissionContent", "51 speakers", talk({ speakers: n(51, () => pk) }));

const pes = (over) => ({ v: 2, favorites: [pk], want_to_meet: [], met: [], notes: {}, ...over });
add("perEventSettings", "legacy (no clock)", pes({}));
add("perEventSettings", "with clock + base", pes({ clock: { favorites: { [pk]: 5 }, met: { [hex("ab")]: 6 } }, base: 3 }));
add("perEventSettings", "clock key not hex", pes({ clock: { favorites: { x: 5 } } }));
add("perEventSettings", "clock stamp negative", pes({ clock: { favorites: { [pk]: -1 } } }));
add("perEventSettings", "base negative", pes({ base: -1 }));

for (const p of payloads) p.ok = P[`${p.schema}Schema`].safeParse(p.payload).success;

// ── 31600 tags: the v tag, the coordinator generation, relay URL filters ───
const configs = [];
const cfgTags = (extra) => [["d", "x"], ["inbox", hex("ab")], ...extra];
const cfg = (label, extra) => {
  const tags = cfgTags(extra);
  let parsed = null;
  try {
    const c = P.parseEventConfig(pk, tags);
    let aBuilt = null;
    try { aBuilt = P.buildEventConfig(c).tags.find((t) => t[0] === "a")[1]; } catch { /* unbuildable */ }
    parsed = { coordinator: c.coordinator ?? null, coordinatorGen: c.coordinatorGen ?? null, relays: c.relays, chatRelays: c.chatRelays,
      spaceKind: c.spaceKind ?? 31923, aBuilt };
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
// SB-09: the `a` tag's kind survives a parse + rebuild only for a community's own coordinate.
cfg("a = own community coordinate", [["v", "2"], ["a", `31612:${pk}:x`]]);
cfg("a = calendar alias (pre-SB-09 community)", [["v", "2"], ["a", `31923:${pk}:x`]]);
cfg("a = someone else's community", [["v", "2"], ["a", `31612:${hex("cd")}:x`]]);

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

// ── Per-event settings merge (SB-88) ──────────────────────────────────────
const settingsMerges = [];
const settingsEdits = [];
{
  const A = hex("a1"), B = hex("b2"), C = hex("c3");
  const legacy = (over) => ({ v: 2, favorites: [], want_to_meet: [], met: [], notes: {}, ...over });
  const E = P.emptyPerEventSettings();
  const ed = (label, doc, docAt, edit, nowMs) => {
    const out = P.editPerEventSettings({ settings: doc, createdAt: docAt }, edit, nowMs);
    settingsEdits.push({ label, doc, docAt, edit, nowMs, out });
    return out;
  };
  const mg = (label, a, aAt, b, bAt) => {
    settingsMerges.push({ label, a, aAt, b, bAt, out: P.mergePerEventSettings({ settings: a, createdAt: aAt }, { settings: b, createdAt: bAt }) });
  };
  const f1 = ed("favourite A", E, 0, { kind: "toggle", list: "favorites", pubkey: A }, 1_000);
  const n1 = ed("note A", f1, 0, { kind: "note", pubkey: A, note: "  relays  " }, 1_001);
  const phone = ed("phone favourites B", n1, 0, { kind: "toggle", list: "favorites", pubkey: B }, 5_000);
  const laptop = ed("laptop marks C met", n1, 0, { kind: "toggle", list: "met", pubkey: C }, 8_000);
  const unfav = ed("phone un-favourites A", phone, 0, { kind: "toggle", list: "favorites", pubkey: A }, 9_000);
  ed("clear note on legacy doc with lagging clock", legacy({ notes: { [A]: "x" } }), 2_000, { kind: "note", pubkey: A, note: " " }, 5);
  ed("toggle on legacy doc", legacy({ want_to_meet: [B] }), 50, { kind: "toggle", list: "want_to_meet", pubkey: C }, 10);
  mg("two devices, same baseline", phone, 5, laptop, 8);
  mg("two devices, reversed", laptop, 8, phone, 5);
  mg("tombstone beats stale copy", unfav, 9, laptop, 8);
  mg("legacy write older than stamps", unfav, 9, legacy({ favorites: [C], notes: { [C]: "old" } }), 3);
  mg("legacy write newer than stamps", unfav, 9, legacy({ favorites: [C] }), 100);
  mg("two legacy docs", legacy({ met: [A] }), 10, legacy({ met: [B] }), 20);
  mg("note tie by text", ed("note tie a", E, 0, { kind: "note", pubkey: A, note: "apple" }, 7_000), 0,
    ed("note tie b", E, 0, { kind: "note", pubkey: A, note: "banana" }, 7_000), 0);
  mg("odd note key carried", legacy({ notes: { "not-a-pubkey": "keep me" } }), 1, laptop, 8);
}

// ── ECK version identity (SB-86, NIP §4.1) ────────────────────────────────
const eckKeyOf = (b) => Buffer.alloc(32, b).toString("base64");
const eckSets = [
  [{ id: 1, key: eckKeyOf(1) }, { id: 2, key: eckKeyOf(2) }, { id: 2, key: eckKeyOf(3) }],
  [{ id: 2, key: eckKeyOf(3) }, { id: 1, key: eckKeyOf(1) }, { id: 2, key: eckKeyOf(2) }, { id: 2, key: eckKeyOf(2) }],
  [{ id: 3, key: eckKeyOf(9) }, { id: 2, key: eckKeyOf(8) }, { id: 3, key: eckKeyOf(4) }, { id: 3, key: eckKeyOf(200) }],
];
const eckIdentity = {
  fingerprints: [0, 1, 2, 7, 255].map((b) => ({ key: eckKeyOf(b), fp: P.eckFingerprint(eckKeyOf(b)) })),
  sets: eckSets.map((set) => ({
    set, union: P.unionEck(set), canonical: P.canonicalEck(set), collisions: P.eckCollisionIds(set),
  })),
  tags: [["eck", "2"], ["eck", "2", P.eckFingerprint(eckKeyOf(3))], ["eck", "2", "XYZ"], ["eck", "0"], ["eck", "2.0", "ABCDEF0123456789"]]
    .map((t) => ({ tag: t, ref: P.readEckTag([t]) ?? null })),
};

// ── Event-keys backup union (SB-89) ───────────────────────────────────────
const backupMerges = [];
{
  const bk = (over) => ({ v: 2, a: coord, eid_nsec: hex("01"), einbox_nsec: hex("02"), eck: [{ id: 1, key: eckKeyOf(1) }], ...over });
  const inboxPk = (h) => P.pubkeyOf(P.hexToBytes(h));
  const mb = (label, a, b, configInbox) =>
    backupMerges.push({ label, a, b, configInbox: configInbox ?? null, out: P.mergeEventKeysBackups(a, b, configInbox ? { configInbox } : {}) });
  mb("two rotations", bk({ eck: [{ id: 1, key: eckKeyOf(1) }, { id: 2, key: eckKeyOf(2) }], coordinator_gen: 1, einbox_nsec: hex("03"), prior_einbox_nsecs: [hex("02")] }),
    bk({ eck: [{ id: 1, key: eckKeyOf(1) }, { id: 2, key: eckKeyOf(3) }], coordinator_gen: 2, einbox_nsec: hex("04"), prior_einbox_nsecs: [hex("02")] }));
  mb("config names the other inbox", bk({ einbox_nsec: hex("03") }), bk({ einbox_nsec: hex("04") }),
    inboxPk(hex("04")));
  mb("staged then promoted", bk({ pending_eck: [{ id: 2, key: eckKeyOf(2) }] }), bk({ eck: [{ id: 1, key: eckKeyOf(1) }, { id: 2, key: eckKeyOf(2) }] }));
  mb("old backup without a", { v: 2, eid_nsec: hex("01"), einbox_nsec: hex("02"), eck: [{ id: 1, key: eckKeyOf(1) }] }, bk({ coordinator_gen: 3 }));
  mb("co-organizers union", bk({ co_organizers: [hex("cc"), hex("aa")] }), bk({ co_organizers: [hex("bb"), hex("aa")] }));
}

writeFileSync(new URL("../../protocol/src/test/resources/parity-vectors.json", import.meta.url),
  JSON.stringify({ payloads, configs, coordinates, menu, settingsMerges, settingsEdits, eckIdentity, backupMerges }, null, 1) + "\n");
console.log(`wrote parity-vectors.json: ${payloads.length} payloads, ${configs.length} configs, ${coordinates.length} coordinates`);
