// Golden vectors from the TypeScript implementation, so the Kotlin port of
// packages/protocol is checked against the real thing rather than against itself.
//   pnpm --filter @nostrautica/protocol build && node android/tools/vectors/generate.mjs
// writes android/protocol/src/test/resources/ts-vectors.json.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../packages/protocol/package.json", import.meta.url));
const P = await import(new URL("../../../packages/protocol/dist/index.js", import.meta.url));
const load = async (m) => { const x = await import(require.resolve(m)); return x.default ?? x; };
const { v2: nip44 } = await load("nostr-tools/nip44");
const pure = await load("nostr-tools/pure");
const { hexToBytes, bytesToHex } = P;

const sk = hexToBytes("0101010101010101010101010101010101010101010101010101010101010101".replace(/01/g, "7a"));
const pk = pure.getPublicKey(sk);
const eck = hexToBytes("11".repeat(32));
const coord = P.makeCoordinate(pk, "plan-b:2026");
const weird = "line\nbreak \"quote\" \\ tab\t \u0001 \u001f   ☃ 😀 \ud800 end";

const out = {
  sk: bytesToHex(sk),
  pk,
  coordinate: coord,
  naddr: P.coordinateToNaddr(coord, ["wss://nos.lol"]),
  communityNaddr: P.coordinateToNaddr(P.makeCoordinate(pk, "c1", 31612)),
  blindedD: P.blindedD(eck, coord, pk),
  blindedLibrary: P.blindedDLiteral(eck, "library"),
  selfConversationKey: bytesToHex(P.selfConversationKey(sk)),
  eckCiphertext: nip44.encrypt("hello members", eck, hexToBytes("22".repeat(32))),
  inviteHash: P.inviteHash(pk),
  eventId: pure.getEventHash({ pubkey: pk, created_at: 1700000000, kind: 1, tags: [["t", weird], ["e", "x"]], content: weird }),
  weird,
  aesGcm: bytesToHex((await P.aesGcmEncrypt(new TextEncoder().encode("media bytes"), hexToBytes("33".repeat(32)), hexToBytes("44".repeat(12)))).ciphertext),
  inviteProof: P.makeInviteProof(hexToBytes("55".repeat(32)), coord, pk),
  chatDeviceProof: P.makeChatDeviceProof(hexToBytes("66".repeat(32)), coord, pk, 1700000123),
  chatDevicePubkey: pure.getPublicKey(hexToBytes("66".repeat(32))),
  wrap: P.wrapRumor(sk, pure.getPublicKey(hexToBytes("77".repeat(32))), { kind: 21600, content: { v: 2, name: "Ada" }, tags: [["a", coord]] }),
  wrapRecipientSk: "77".repeat(32),
};

// 31600 config: the builder's tags, and a parse of hostile/legacy tags.
const cfg = { d: "plan-b:2026", eidPubkey: pk, inbox: "ab".repeat(32), coordinator: "cd".repeat(32), coordinatorGen: 3,
  relays: ["wss://nos.lol"], chatRelays: ["wss://relay.eu.whitenoise.chat"], blossom: ["https://blossom.band"],
  maxVideoSec: 0, maxTalkSec: 900, matching: "on", matchVisibility: "pair", approval: "manual+invite", eck: 4,
  nostrContext: 100, lang: "sk", talks: "prerecord-first", chat: ["marmot"], retentionDays: 30 };
out.configTags = P.buildEventConfig(cfg).tags;
const hostile = [["d", "x"], ["v", "2"], ["inbox", "ab".repeat(32)], ["coordinator", "cd".repeat(32)],
  ["relay", "wss://relay.us.whitenoise.chat/"], ["relay", "https://not-a-relay"], ["relay", "wss://nos.lol"],
  ["max_video_sec", ""], ["max_talk_sec", "-5"], ["approval", "yolo"], ["talks", "maybe"], ["chat", "marmot"], ["chat", "irc"],
  ["lang", "de-AT"], ["eck", "0"], ["retention", "1.5"], ["blossom", "http://insecure"]];
out.hostileTags = hostile;
out.hostileParsed = P.parseEventConfig(pk, hostile);

// Roster pagination: a roster past the NIP-44 ceiling.
const att = Array.from({ length: 600 }, (_, i) => ({ pubkey: (i.toString(16).padStart(4, "0")).repeat(16), d: "d".repeat(32),
  role: i === 0 ? "organizer" : "attendee", ...(i % 3 === 0 ? { chat_keys: [{ pubkey: "ef".repeat(32), label: "Pixel " + i, added_at: 1700000000 + i }] } : {}) }));
const big = { v: 2, eck_current: 7, nostr_group_id: "12".repeat(32), attendees: att };
out.rosterInput = big;
out.rosterPages = P.splitRoster(big).map((p) => ({ v: p.v, pages: p.pages ?? null, n: p.attendees.length, first: p.attendees[0].pubkey }));

// Payloads exactly as the TS app emits them, for the Kotlin schemas to parse.
out.directoryEntry = P.directoryEntryContentSchema.parse({ v: 2, pubkey: pk, name: "Ada", profile: { about: "hi", skills: ["rust"] },
  media: [{ kind: "intro", url: ["https://blossom.band/" + "aa".repeat(32)], x: "aa".repeat(32), ox: "bb".repeat(32), size: 10, m: "video/mp4", duration: 12.5,
    "encryption-algorithm": "aes-gcm", "decryption-key": P.bytesToBase64(hexToBytes("33".repeat(32))), "decryption-nonce": P.bytesToBase64(hexToBytes("44".repeat(12))) }],
  ai_profile: { summary: "S", skills: [], interests: ["x"], offers: [], seeks: [] }, updated_at: 1700000000 });
out.newerPayload = { v: 3, pubkey: pk, profile: {}, updated_at: 1 };
writeFileSync(new URL("../../protocol/src/test/resources/ts-vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("wrote ts-vectors.json");
