import { describe, it, expect } from "vitest";
import { encryptMedia } from "./media.js";
import {
  talkSubmissionContentSchema,
  talkContentSchema,
  mediaDescriptorSchema,
  joinRequestContentSchema,
  profileSubmissionContentSchema,
  keyGrantContentSchema,
  coordinatorGrantContentSchema,
  organizerGrantContentSchema,
  adminCommandContentSchema,
  inviteListContentSchema,
  myProfileContentSchema,
  directoryEntryContentSchema,
  rosterContentSchema,
  matchListContentSchema,
  matchMatrixContentSchema,
  perEventSettingsSchema,
  eventKeysBackupSchema,
  coordinatorStatusContentSchema,
  mediaTranscriptSchema,
  profileCorrectionContentSchema,
  withdrawalContentSchema,
  chatKeyAttestationContentSchema,
  attendeeProfileSchema,
  aiProfileSchema,
  membersPostContentSchema,
  menuItemSchema,
  userSettingsSchema,
  coordinatorAnnounceSchema,
  coordinatorBillingSchema,
  coordinatorPricingSchema,
  MAX_NAME,
  MAX_MESSAGE,
  MAX_ABOUT,
  MAX_LOOKING_FOR,
  MAX_SKILLS,
  MAX_SKILL,
  MAX_LINKS,
  MAX_URL,
  MAX_INVITE_LABEL,
  MAX_INVITES,
  MAX_REASONING,
  MAX_MATCHES,
  MAX_ROSTER,
  MAX_RELAYS,
  MAX_MEDIA,
  MAX_SUBMISSION_MEDIA,
  MAX_LIBRARY_TEXTS,
  MAX_INTRO_TEXT,
  MAX_LANG,
  MAX_D,
  MAX_TRANSCRIPT_TEXT,
  MAX_MATCH_PAIRS,
  MAX_TITLE,
  MAX_POST_BODY,
  MAX_NOTES,
  MAX_NOTE,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_TAG,
  parsePayload,
  parsePayloadSafe,
  isNewerProtocolVersion,
  readPayloadVersion,
  hasCurrentVersionTag,
  isNewerVersionTag,
  readEventVersionTag,
  NewerProtocolVersionError,
} from "./schemas.js";
import type { z } from "zod";

const hex = "a".repeat(64);
const b64_32 = "A".repeat(43) + "=";
const b64_12 = "A".repeat(16);

const descriptor = {
  kind: "intro",
  url: ["https://blossom.example/" + hex + ".bin"],
  x: hex,
  ox: "b".repeat(64),
  size: 12345,
  m: "video/webm",
  duration: 87,
  "encryption-algorithm": "aes-gcm",
  "decryption-key": b64_32,
  "decryption-nonce": b64_12,
};

/** parse(x) then re-parse — a valid payload survives a JSON round-trip unchanged. */
function roundTrips<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.parse(value);
  const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(again).toEqual(parsed);
}

describe("every §7 payload round-trips through JSON", () => {
  it("media descriptor", () => roundTrips(mediaDescriptorSchema, descriptor));

  it("21600 join request", () =>
    roundTrips(joinRequestContentSchema, {
      v: 2,
      name: "Alice",
      message: "hi",
      rsvp_public: false,
    }));

  it("21601 profile submission", () =>
    roundTrips(profileSubmissionContentSchema, {
      v: 2,
      rev: 0,
      profile: { about: "dev", skills: ["rust"], looking_for: "cofounder", links: [] },
      media: [descriptor],
    }));

  it("21602 key grant", () =>
    roundTrips(keyGrantContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      role: "attendee",
      eck: [{ id: 1, key: b64_32 }],
      granted_by: hex,
    }));

  it("21603 coordinator grant", () =>
    roundTrips(coordinatorGrantContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      gen: 1,
      inbox_nsec: hex,
      eck: [{ id: 1, key: b64_32 }],
      config_relays: ["wss://relay.example"],
    }));

  it("21603 coordinator grant requires a positive gen (NIP §3.5)", () => {
    expect(() =>
      coordinatorGrantContentSchema.parse({
        v: 2, a: "31923:" + hex + ":ev", inbox_nsec: hex, eck: [{ id: 1, key: b64_32 }], config_relays: [],
      }),
    ).toThrow();
    expect(() =>
      coordinatorGrantContentSchema.parse({
        v: 2, a: "31923:" + hex + ":ev", gen: 0, inbox_nsec: hex, eck: [{ id: 1, key: b64_32 }], config_relays: [],
      }),
    ).toThrow();
  });

  it("21603/21602 grants reject a non-31923 coordinate `a` (audit R18)", () => {
    // An alias kind against the same author/identifier would open a divergent
    // capacity/accounting namespace — the schema now rejects it at the boundary.
    expect(() =>
      coordinatorGrantContentSchema.parse({
        v: 2, a: "1:" + hex + ":ev", gen: 1, inbox_nsec: hex, eck: [{ id: 1, key: b64_32 }], config_relays: [],
      }),
    ).toThrow();
    expect(() =>
      keyGrantContentSchema.parse({
        v: 2, a: "31600:" + hex + ":ev", role: "attendee", eck: [{ id: 1, key: b64_32 }], granted_by: hex,
      }),
    ).toThrow();
    // The canonical 31923 coordinate is still accepted.
    expect(() =>
      coordinatorGrantContentSchema.parse({
        v: 2, a: "31923:" + hex + ":ev", gen: 1, inbox_nsec: hex, eck: [{ id: 1, key: b64_32 }], config_relays: [],
      }),
    ).not.toThrow();
  });

  it("21604 admin command", () =>
    roundTrips(adminCommandContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      cmd: "revoke",
      args: { pubkey: hex },
      expires: 1_800_000_000,
    }));

  it("21604 admin command requires expires (NIP §3.4)", () =>
    expect(() =>
      adminCommandContentSchema.parse({ v: 2, a: "31923:" + hex + ":ev", cmd: "recompute" }),
    ).toThrow());

  it("21604 accepts the detach command (NIP §3.5)", () =>
    roundTrips(adminCommandContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      cmd: "detach",
      expires: 1_800_000_000,
    }));

  it("31601 invite list", () =>
    roundTrips(inviteListContentSchema, {
      v: 2,
      invites: [{ h: hex, label: "vip-1" }],
    }));

  it("31602 my profile (event + library variants)", () => {
    roundTrips(myProfileContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [descriptor],
    });
    roundTrips(myProfileContentSchema, { v: 2, a: null, media: [descriptor] });
    // Library variant carrying cross-event reusable TEXT intros (F1 reuse).
    roundTrips(myProfileContentSchema, {
      v: 2,
      a: null,
      media: [],
      intro_texts: ["Hi, I build Nostr tools.", "Second intro"],
    });
  });

  it("31603 directory entry", () =>
    roundTrips(directoryEntryContentSchema, {
      v: 2,
      pubkey: hex,
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [descriptor],
      ai_profile: {
        summary: "builds nostr apps",
        skills: ["ts"],
        interests: ["privacy"],
        offers: ["code"],
        seeks: ["design"],
      },
      updated_at: 1_700_000_000,
    }));

  it("31604 roster", () =>
    roundTrips(rosterContentSchema, {
      v: 2,
      eck_current: 1,
      attendees: [{ pubkey: hex, d: "deadbeef", role: "attendee" }],
    }));

  it("31604 roster carries per-device chat_keys per attendee (NIP §6.2)", () =>
    roundTrips(rosterContentSchema, {
      v: 2,
      eck_current: 2,
      nostr_group_id: "d".repeat(64),
      attendees: [
        {
          pubkey: hex,
          d: "deadbeef",
          role: "attendee",
          chat_keys: [
            { pubkey: "b".repeat(64), label: "Chrome on macOS", added_at: 1_700_000_000 },
            { pubkey: "e".repeat(64), added_at: 1_700_000_100 }, // label optional
          ],
        },
        { pubkey: "c".repeat(64), d: "cafe", role: "organizer" }, // no chat keys
      ],
    }));

  it("31604 roster rejects more than MAX_CHAT_KEYS_PER_ACCOUNT chat_keys", () => {
    expect(() =>
      rosterContentSchema.parse({
        v: 2,
        eck_current: 1,
        attendees: [
          {
            pubkey: hex,
            d: "d",
            role: "attendee",
            chat_keys: Array.from({ length: 6 }, (_, i) => ({
              pubkey: String(i).repeat(64).slice(0, 64),
              added_at: 1,
            })),
          },
        ],
      }),
    ).toThrow();
  });

  it("21607 chat device attestation round-trips (add with proof+label, revoke)", () => {
    roundTrips(chatKeyAttestationContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      op: "add",
      chat_pubkey: "b".repeat(64),
      label: "Chrome on macOS",
      client_id: "device-1",
      proof: "a".repeat(128),
    });
    roundTrips(chatKeyAttestationContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      op: "revoke",
      chat_pubkey: "b".repeat(64),
    });
  });

  it("21607 add REQUIRES a proof of possession and a label (NIP §10.2)", () => {
    // add without proof → rejected
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        op: "add",
        chat_pubkey: "b".repeat(64),
        label: "Chrome",
      }),
    ).toThrow();
    // add without label → rejected
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        op: "add",
        chat_pubkey: "b".repeat(64),
        proof: "a".repeat(128),
      }),
    ).toThrow();
    // malformed proof (not 128-hex) → rejected
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        op: "add",
        chat_pubkey: "b".repeat(64),
        label: "Chrome",
        proof: "xyz",
      }),
    ).toThrow();
  });

  it("21607 rejects an unknown op and an unexpected field (strict)", () => {
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        op: "delete", // not add/revoke
        chat_pubkey: "b".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        op: "add",
        chat_pubkey: "b".repeat(64),
        label: "Chrome",
        proof: "a".repeat(128),
        rogue: true, // strict → rejected
      }),
    ).toThrow();
  });

  it("31605 match list", () =>
    roundTrips(matchListContentSchema, {
      v: 2,
      computed_at: 1_700_000_000,
      matches: [
        {
          pubkey: hex,
          score: 0.87,
          similarity: 0.6,
          complementarity: 0.95,
          reasoning: "complementary skills",
        },
      ],
    }));

  it("31606 match matrix", () =>
    roundTrips(matchMatrixContentSchema, {
      v: 2,
      computed_at: 1_700_000_000,
      pairs: [{ a: hex, b: "b".repeat(64), score: 0.5 }],
    }));

  it("30078 per-event settings", () =>
    roundTrips(perEventSettingsSchema, {
      v: 2,
      favorites: [hex],
      want_to_meet: [],
      met: [],
      notes: { [hex]: "met at coffee" },
    }));

  it("30078 event keys backup", () =>
    roundTrips(eventKeysBackupSchema, {
      v: 2,
      eid_nsec: hex,
      einbox_nsec: "b".repeat(64),
      eck: [{ id: 1, key: b64_32 }],
    }));

  it("30078 event keys backup with coordinate", () =>
    roundTrips(eventKeysBackupSchema, {
      v: 2,
      a: `31923:${hex}:cypherpunk-2026`,
      eid_nsec: hex,
      einbox_nsec: "b".repeat(64),
      eck: [{ id: 1, key: b64_32 }],
    }));
});

describe("schema validation rejects malformed payloads", () => {
  it("rejects a bad hex pubkey", () => {
    expect(() =>
      keyGrantContentSchema.parse({
        v: 2,
        a: "x",
        role: "attendee",
        eck: [],
        granted_by: "nothex",
      }),
    ).toThrow();
  });

  it("rejects uppercase hex pubkeys (PROTO-6: downstream comparisons are case-sensitive)", () => {
    expect(() =>
      keyGrantContentSchema.parse({
        v: 2,
        a: "x",
        role: "attendee",
        eck: [],
        granted_by: "A".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      keyGrantContentSchema.parse({
        v: 2,
        a: "x",
        role: "attendee",
        eck: [],
        granted_by: "aA".repeat(32), // mixed case
      }),
    ).toThrow();
  });

  it("rejects an unknown media kind", () => {
    expect(() => mediaDescriptorSchema.parse({ ...descriptor, kind: "audio" })).toThrow();
  });

  it("applies defaults for optional fields", () => {
    const parsed = joinRequestContentSchema.parse({ v: 2, name: "Bob" });
    expect(parsed.message).toBe("");
    expect(parsed.rsvp_public).toBe(false);
  });

  // ── Q6/Q7: tightened crypto-material + boundary validation ────────────────
  it("rejects a non-https media URL (C3)", () => {
    expect(() =>
      mediaDescriptorSchema.parse({ ...descriptor, url: ["http://blossom.example/x.bin"] }),
    ).toThrow();
    expect(() =>
      mediaDescriptorSchema.parse({ ...descriptor, url: ["file:///etc/passwd"] }),
    ).toThrow();
  });

  it("rejects a decryption key/nonce of the wrong decoded length (Q6)", () => {
    // 31-byte key (b64 of 31 bytes) and a 16-byte nonce are both wrong.
    expect(() =>
      mediaDescriptorSchema.parse({ ...descriptor, "decryption-key": "A".repeat(42) + "==" }),
    ).toThrow();
    expect(() =>
      mediaDescriptorSchema.parse({ ...descriptor, "decryption-nonce": b64_32 }),
    ).toThrow();
  });

  it("rejects an unknown extra field on the strict media descriptor (Q6)", () => {
    expect(() =>
      mediaDescriptorSchema.parse({ ...descriptor, evil: "surprise" }),
    ).toThrow();
  });

  it("rejects an ECK key that is not 32 decoded bytes (Q6)", () => {
    expect(() =>
      keyGrantContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        role: "attendee",
        eck: [{ id: 1, key: "A".repeat(4) }], // 3 bytes
        granted_by: hex,
      }),
    ).toThrow();
  });

  it("rejects a non-hex inbox_nsec on the coordinator grant (Q6)", () => {
    expect(() =>
      coordinatorGrantContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        inbox_nsec: "not-a-hex-secret-key",
        eck: [{ id: 1, key: b64_32 }],
        config_relays: ["wss://relay.example"],
      }),
    ).toThrow();
  });

  it("round-trips the 21606 coordinator status payload (Q12)", () => {
    roundTrips(coordinatorStatusContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      pubkey: hex,
      stage: "process_attendee",
      state: "poison",
      attempts: 5,
      error_category: "provider_contract",
      retryable: false,
      at: 1_700_000_000,
    });
  });
});

// ── F1: text/audio intro alternatives + transcript surfacing ─────────────────
describe("F1 — intro_text + MediaTranscript on 21601 / 31603", () => {
  const transcript = {
    x: hex,
    text: "Hi, I build privacy tools.",
    lang: "en",
    source: "stt" as const,
    updated_at: 1_700_000_000,
  };

  it("21601 submission round-trips with a text intro (no media)", () =>
    roundTrips(profileSubmissionContentSchema, {
      v: 2,
      rev: 3,
      profile: { about: "dev", skills: ["rust"], looking_for: "cofounder", links: [] },
      media: [],
      intro_text: "I write Rust and care about privacy. Looking to meet designers.",
    }));

  it("21601 submission caps intro_text at MAX_INTRO_TEXT", () =>
    expect(() =>
      profileSubmissionContentSchema.parse({
        v: 2,
        rev: 0,
        profile: { about: "", skills: [], looking_for: "", links: [] },
        media: [],
        intro_text: "x".repeat(2001),
      }),
    ).toThrow());

  it("21601 submission requires rev (NIP §3.3)", () =>
    expect(() =>
      profileSubmissionContentSchema.parse({
        v: 2,
        profile: { about: "", skills: [], looking_for: "", links: [] },
        media: [],
      }),
    ).toThrow());

  it("21608 correction requires rev (NIP §3.3)", () =>
    expect(() =>
      profileCorrectionContentSchema.parse({ v: 2, a: coordinate, hidden: true }),
    ).toThrow());

  it("MediaTranscript round-trips and is strict", () => {
    roundTrips(mediaTranscriptSchema, transcript);
    expect(() => mediaTranscriptSchema.parse({ ...transcript, evil: 1 })).toThrow();
    expect(() => mediaTranscriptSchema.parse({ ...transcript, source: "guess" })).toThrow();
  });

  it("31603 directory entry round-trips with transcripts + intro_text", () =>
    roundTrips(directoryEntryContentSchema, {
      v: 2,
      pubkey: hex,
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [descriptor], // descriptor.x === hex, matching transcript.x
      transcripts: [transcript],
      intro_text: "typed intro",
      updated_at: 1_700_000_000,
    }));

  it("31603 rejects a transcript whose x doesn't match any live media (stale drop)", () => {
    expect(() =>
      directoryEntryContentSchema.parse({
        v: 2,
        pubkey: hex,
        profile: { about: "x", skills: [], looking_for: "", links: [] },
        media: [descriptor], // x === hex
        transcripts: [{ ...transcript, x: "c".repeat(64) }], // orphaned (media replaced)
        updated_at: 1_700_000_000,
      }),
    ).toThrow();
  });

  it("31603 accepts a transcript once its media is present again (re-record)", () => {
    // A text-only entry (no media) may carry intro_text but no transcripts.
    const parsed = directoryEntryContentSchema.parse({
      v: 2,
      pubkey: hex,
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [],
      intro_text: "text only",
      updated_at: 1_700_000_000,
    });
    expect(parsed.intro_text).toBe("text only");
    expect(parsed.transcripts).toBeUndefined();
  });
});

describe("F3 — profile correction (21608) + ai_profile_edited on 31603", () => {
  const coordinate = "31600:" + hex + ":cypherpunk";

  it("a field-override correction round-trips", () =>
    roundTrips(profileCorrectionContentSchema, {
      v: 2,
      a: coordinate,
      rev: 0,
      overrides: { summary: "I actually build hardware, not software.", skills: ["soldering"] },
    }));

  it("a hide-everything correction round-trips", () =>
    roundTrips(profileCorrectionContentSchema, { v: 2, a: coordinate, rev: 1, hidden: true }));

  it("hidden_fields + report round-trip", () =>
    roundTrips(profileCorrectionContentSchema, {
      v: 2,
      a: coordinate,
      rev: 0,
      hidden_fields: ["interests", "seeks"],
      report: "The AI invented interests I never mentioned.",
    }));

  it("rejects an unknown ai_profile field in hidden_fields", () =>
    expect(() =>
      profileCorrectionContentSchema.parse({ v: 2, a: coordinate, hidden_fields: ["about"] }),
    ).toThrow());

  it("caps the report length at MAX_INTRO_TEXT", () =>
    expect(() =>
      profileCorrectionContentSchema.parse({ v: 2, a: coordinate, report: "x".repeat(2001) }),
    ).toThrow());

  it("31603 directory entry round-trips with ai_profile_edited", () =>
    roundTrips(directoryEntryContentSchema, {
      v: 2,
      pubkey: hex,
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [],
      ai_profile: { summary: "s", skills: [], interests: [], offers: [], seeks: [] },
      ai_profile_edited: true,
      updated_at: 1_700_000_000,
    }));
});

// ── PROTO-4: boundary length caps (DoS / NIP-44-ceiling overflow) ────────────
describe("boundary length caps (PROTO-4)", () => {
  const emptyProfile = { about: "", skills: [], looking_for: "", links: [] };

  it("21600 join request: name ≤ MAX_NAME, message ≤ MAX_MESSAGE", () => {
    roundTrips(joinRequestContentSchema, {
      v: 2,
      name: "n".repeat(MAX_NAME),
      message: "m".repeat(MAX_MESSAGE),
    });
    expect(() =>
      joinRequestContentSchema.parse({ v: 2, name: "n".repeat(MAX_NAME + 1) }),
    ).toThrow();
    expect(() =>
      joinRequestContentSchema.parse({ v: 2, name: "ok", message: "m".repeat(MAX_MESSAGE + 1) }),
    ).toThrow();
  });

  it("attendee profile: about/looking_for/skills/links caps, boundary values accepted", () => {
    const maxUrl = "https://example.com/" + "u".repeat(MAX_URL - "https://example.com/".length);
    roundTrips(attendeeProfileSchema, {
      about: "a".repeat(MAX_ABOUT),
      skills: Array(MAX_SKILLS).fill("s".repeat(MAX_SKILL)),
      looking_for: "l".repeat(MAX_LOOKING_FOR),
      links: Array(MAX_LINKS).fill(maxUrl),
    });
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, about: "a".repeat(MAX_ABOUT + 1) }),
    ).toThrow();
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, looking_for: "l".repeat(MAX_LOOKING_FOR + 1) }),
    ).toThrow();
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, skills: Array(MAX_SKILLS + 1).fill("s") }),
    ).toThrow();
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, skills: ["s".repeat(MAX_SKILL + 1)] }),
    ).toThrow();
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, links: Array(MAX_LINKS + 1).fill("https://example.com") }),
    ).toThrow();
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, links: ["not-a-url"] }),
    ).toThrow();
    expect(() =>
      attendeeProfileSchema.parse({ ...emptyProfile, links: [maxUrl + "x"] }),
    ).toThrow();
  });

  it("31601 invite list: label ≤ MAX_INVITE_LABEL, invites ≤ MAX_INVITES", () => {
    roundTrips(inviteListContentSchema, {
      v: 2,
      invites: Array(MAX_INVITES).fill({ h: hex, label: "l".repeat(MAX_INVITE_LABEL) }),
    });
    expect(() =>
      inviteListContentSchema.parse({
        v: 2,
        invites: [{ h: hex, label: "l".repeat(MAX_INVITE_LABEL + 1) }],
      }),
    ).toThrow();
    expect(() =>
      inviteListContentSchema.parse({ v: 2, invites: Array(MAX_INVITES + 1).fill({ h: hex }) }),
    ).toThrow();
  });

  it("31605 match list: reasoning ≤ MAX_REASONING, matches ≤ MAX_MATCHES", () => {
    const match = {
      pubkey: hex,
      score: 0.5,
      similarity: 0.5,
      complementarity: 0.5,
      reasoning: "r".repeat(MAX_REASONING),
    };
    roundTrips(matchListContentSchema, {
      v: 2,
      computed_at: 1,
      matches: Array(MAX_MATCHES).fill(match),
    });
    expect(() =>
      matchListContentSchema.parse({
        v: 2,
        computed_at: 1,
        matches: [{ ...match, reasoning: "r".repeat(MAX_REASONING + 1) }],
      }),
    ).toThrow();
    expect(() =>
      matchListContentSchema.parse({
        v: 2,
        computed_at: 1,
        matches: Array(MAX_MATCHES + 1).fill(match),
      }),
    ).toThrow();
  });

  it("31605 icebreakers: ≤ 3 per match, ≤ 280 chars each (NIP §6.2)", () => {
    const base = { pubkey: hex, score: 0.5, similarity: 0.5, complementarity: 0.5, reasoning: "r" };
    // Present + within bounds round-trips.
    roundTrips(matchListContentSchema, {
      v: 2,
      computed_at: 1,
      matches: [{ ...base, icebreakers: ["a".repeat(280), "hi", "hey"] }],
    });
    // Absent is fine (additive field).
    roundTrips(matchListContentSchema, { v: 2, computed_at: 1, matches: [base] });
    // > 3 icebreakers rejected.
    expect(() =>
      matchListContentSchema.parse({
        v: 2,
        computed_at: 1,
        matches: [{ ...base, icebreakers: ["1", "2", "3", "4"] }],
      }),
    ).toThrow();
    // An oversized icebreaker rejected.
    expect(() =>
      matchListContentSchema.parse({
        v: 2,
        computed_at: 1,
        matches: [{ ...base, icebreakers: ["x".repeat(281)] }],
      }),
    ).toThrow();
  });

  it("21610 withdrawal: strict, delete_data defaults true (NIP §6.3)", () => {
    // Default fills in delete_data:true.
    expect(withdrawalContentSchema.parse({ v: 2, a: "31923:pk:d" })).toEqual({
      v: 2,
      a: "31923:pk:d",
      delete_data: true,
    });
    roundTrips(withdrawalContentSchema, { v: 2, a: "31923:pk:d", delete_data: false });
    // Strict: an unknown field is rejected.
    expect(() =>
      withdrawalContentSchema.parse({ v: 2, a: "31923:pk:d", extra: 1 }),
    ).toThrow();
    // Wrong version rejected (strict wire v2).
    expect(() => withdrawalContentSchema.parse({ v: 1, a: "x" })).toThrow();
  });

  it("31604 roster: attendees ≤ MAX_ROSTER", () => {
    const attendee = { pubkey: hex, d: "deadbeef", role: "attendee" };
    roundTrips(rosterContentSchema, {
      v: 2,
      eck_current: 1,
      attendees: Array(MAX_ROSTER).fill(attendee),
    });
    expect(() =>
      rosterContentSchema.parse({
        v: 2,
        eck_current: 1,
        attendees: Array(MAX_ROSTER + 1).fill(attendee),
      }),
    ).toThrow();
    // Inner blinded `d` is bounded too (P2).
    expect(() =>
      rosterContentSchema.parse({
        v: 2,
        eck_current: 1,
        attendees: [{ ...attendee, d: "d".repeat(MAX_D + 1) }],
      }),
    ).toThrow();
  });

  it("21603/21605 grants: config_relays ≤ MAX_RELAYS", () => {
    roundTrips(coordinatorGrantContentSchema, {
      v: 2,
      a: "31923:" + hex + ":ev",
      gen: 1,
      inbox_nsec: hex,
      eck: [{ id: 1, key: b64_32 }],
      config_relays: Array(MAX_RELAYS).fill("wss://relay.example"),
    });
    expect(() =>
      coordinatorGrantContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        inbox_nsec: hex,
        eck: [{ id: 1, key: b64_32 }],
        config_relays: Array(MAX_RELAYS + 1).fill("wss://relay.example"),
      }),
    ).toThrow();
    expect(() =>
      organizerGrantContentSchema.parse({
        v: 2,
        a: "31923:" + hex + ":ev",
        eid_nsec: hex,
        einbox_nsec: hex,
        eck: [{ id: 1, key: b64_32 }],
        config_relays: Array(MAX_RELAYS + 1).fill("wss://relay.example"),
        granted_by: hex,
      }),
    ).toThrow();
  });

  it("relay URL arrays elsewhere (user settings, coordinator announcement) ≤ MAX_RELAYS", () => {
    roundTrips(userSettingsSchema, { v: 2, relays: Array(MAX_RELAYS).fill("wss://r") });
    expect(() =>
      userSettingsSchema.parse({ v: 2, relays: Array(MAX_RELAYS + 1).fill("wss://r") }),
    ).toThrow();
    roundTrips(coordinatorAnnounceSchema, {
      v: 2,
      name: "coord",
      relays: Array(MAX_RELAYS).fill("wss://r"),
      features: { matching: true, talks: false, chat: Array(MAX_RELAYS).fill("wss://r") },
    });
    expect(() =>
      coordinatorAnnounceSchema.parse({
        v: 2,
        name: "coord",
        relays: Array(MAX_RELAYS + 1).fill("wss://r"),
      }),
    ).toThrow();
    expect(() =>
      coordinatorAnnounceSchema.parse({
        v: 2,
        name: "coord",
        features: { matching: true, talks: false, chat: Array(MAX_RELAYS + 1).fill("wss://r") },
      }),
    ).toThrow();
  });

  it("media transcript: text ≤ MAX_TRANSCRIPT_TEXT, lang ≤ MAX_LANG (P2)", () => {
    const base = { x: hex, source: "stt" as const, updated_at: 1 };
    roundTrips(mediaTranscriptSchema, {
      ...base,
      text: "t".repeat(MAX_TRANSCRIPT_TEXT),
      lang: "l".repeat(MAX_LANG),
    });
    expect(() =>
      mediaTranscriptSchema.parse({ ...base, text: "t".repeat(MAX_TRANSCRIPT_TEXT + 1), lang: "en" }),
    ).toThrow();
    expect(() =>
      mediaTranscriptSchema.parse({ ...base, text: "ok", lang: "l".repeat(MAX_LANG + 1) }),
    ).toThrow();
  });

  it("ai_profile: summary/skills/interests/offers/seeks caps (P2)", () => {
    const ok = {
      summary: "s".repeat(MAX_ABOUT),
      skills: Array(MAX_SKILLS).fill("s".repeat(MAX_SKILL)),
      interests: Array(MAX_SKILLS).fill("i"),
      offers: Array(MAX_SKILLS).fill("o"),
      seeks: Array(MAX_SKILLS).fill("k"),
    };
    roundTrips(aiProfileSchema, ok);
    expect(() => aiProfileSchema.parse({ ...ok, summary: "s".repeat(MAX_ABOUT + 1) })).toThrow();
    expect(() => aiProfileSchema.parse({ ...ok, interests: Array(MAX_SKILLS + 1).fill("i") })).toThrow();
    expect(() => aiProfileSchema.parse({ ...ok, skills: ["s".repeat(MAX_SKILL + 1)] })).toThrow();
  });

  it("31606 match matrix: pairs ≤ MAX_MATCH_PAIRS (P2)", () => {
    const pair = { a: hex, b: hex, score: 0.5 };
    roundTrips(matchMatrixContentSchema, { v: 2, computed_at: 1, pairs: [pair] });
    expect(() =>
      matchMatrixContentSchema.parse({
        v: 2,
        computed_at: 1,
        pairs: Array(MAX_MATCH_PAIRS + 1).fill(pair),
      }),
    ).toThrow();
  });

  it("31607 members post: title/summary/image/content caps (P2)", () => {
    const ok = {
      v: 2,
      title: "t".repeat(MAX_TITLE),
      summary: "s".repeat(MAX_MESSAGE),
      image: "https://example.com/" + "u".repeat(MAX_URL - "https://example.com/".length),
      published_at: 1,
      content: "c".repeat(MAX_POST_BODY),
    };
    roundTrips(membersPostContentSchema, ok);
    expect(() => membersPostContentSchema.parse({ ...ok, title: "t".repeat(MAX_TITLE + 1) })).toThrow();
    expect(() => membersPostContentSchema.parse({ ...ok, content: "c".repeat(MAX_POST_BODY + 1) })).toThrow();
  });

  it("31608 menu item: label ≤ MAX_NAME, target ≤ MAX_URL (P2)", () => {
    const target = "https://example.com/" + "u".repeat(MAX_URL - "https://example.com/".length);
    roundTrips(menuItemSchema, { label: "l".repeat(MAX_NAME), target });
    expect(() => menuItemSchema.parse({ label: "l".repeat(MAX_NAME + 1), target: "x" })).toThrow();
    expect(() => menuItemSchema.parse({ label: "ok", target: target + "x" })).toThrow();
  });

  it("per-event settings: note length ≤ MAX_NOTE, note count ≤ MAX_NOTES, id arrays ≤ MAX_ROSTER (P2)", () => {
    roundTrips(perEventSettingsSchema, {
      v: 2,
      notes: { [hex]: "n".repeat(MAX_NOTE) },
      favorites: Array(MAX_ROSTER).fill(hex),
    });
    expect(() =>
      perEventSettingsSchema.parse({ v: 2, notes: { [hex]: "n".repeat(MAX_NOTE + 1) } }),
    ).toThrow();
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < MAX_NOTES + 1; i++) tooMany[i.toString(16).padStart(64, "0")] = "x";
    expect(() => perEventSettingsSchema.parse({ v: 2, notes: tooMany })).toThrow();
    expect(() =>
      perEventSettingsSchema.parse({ v: 2, favorites: Array(MAX_ROSTER + 1).fill(hex) }),
    ).toThrow();
  });

  it("terms_url / checkout_url are https-only at the schema boundary (audit APPR-1/APPR-2)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "http://example.com/terms", // plaintext http, not just non-URL schemes
      "not a url",
    ]) {
      expect(() => coordinatorAnnounceSchema.parse({ v: 2, name: "coord", terms_url: bad })).toThrow();
      expect(() => coordinatorBillingSchema.parse({ state: "ok", checkout_url: bad })).toThrow();
      expect(() =>
        coordinatorPricingSchema.parse({ model: "per_user", checkout_url: bad }),
      ).toThrow();
    }
    roundTrips(coordinatorAnnounceSchema, {
      v: 2,
      name: "coord",
      terms_url: "https://example.com/terms",
    });
    roundTrips(coordinatorBillingSchema, {
      state: "payment_required",
      checkout_url: "https://example.com/pay",
    });
    roundTrips(coordinatorPricingSchema, {
      model: "per_user",
      checkout_url: "https://example.com/pay",
    });
    // Both fields stay optional — a free/no-terms coordinator omits them.
    roundTrips(coordinatorAnnounceSchema, { v: 2, name: "coord" });
    roundTrips(coordinatorBillingSchema, { state: "ok" });
  });

  it("31603 directory entry: name ≤ MAX_NAME and profile caps apply", () => {
    const base = { v: 2, pubkey: hex, profile: emptyProfile, media: [], updated_at: 1 };
    roundTrips(directoryEntryContentSchema, { ...base, name: "n".repeat(MAX_NAME) });
    expect(() =>
      directoryEntryContentSchema.parse({ ...base, name: "n".repeat(MAX_NAME + 1) }),
    ).toThrow();
    expect(() =>
      directoryEntryContentSchema.parse({
        ...base,
        profile: { ...emptyProfile, about: "a".repeat(MAX_ABOUT + 1) },
      }),
    ).toThrow();
  });

  it("media arrays are capped (21601 at MAX_SUBMISSION_MEDIA, 31602 / 31603 at MAX_MEDIA)", () => {
    // v2 (NIP §8): a 21601 submission is capped at 4; the 31602 library holds up to 20.
    roundTrips(profileSubmissionContentSchema, {
      v: 2,
      rev: 0,
      profile: emptyProfile,
      media: Array(MAX_SUBMISSION_MEDIA).fill(descriptor),
    });
    expect(
      () =>
        profileSubmissionContentSchema.parse({
          v: 2,
          profile: emptyProfile,
          media: Array(MAX_SUBMISSION_MEDIA + 1).fill(descriptor),
        }),
    ).toThrow();
    roundTrips(myProfileContentSchema, { v: 2, a: null, media: Array(MAX_MEDIA).fill(descriptor) });
    const tooMany = Array(MAX_MEDIA + 1).fill(descriptor);
    expect(() => myProfileContentSchema.parse({ v: 2, a: null, media: tooMany })).toThrow();
    // The reuse text library is likewise bounded (count + per-item length).
    expect(() =>
      myProfileContentSchema.parse({
        v: 2,
        a: null,
        media: [],
        intro_texts: Array(MAX_LIBRARY_TEXTS + 1).fill("x"),
      }),
    ).toThrow();
    expect(() =>
      myProfileContentSchema.parse({
        v: 2,
        a: null,
        media: [],
        intro_texts: ["x".repeat(MAX_INTRO_TEXT + 1)],
      }),
    ).toThrow();
    expect(() =>
      directoryEntryContentSchema.parse({
        v: 2,
        pubkey: hex,
        profile: emptyProfile,
        media: tooMany,
        updated_at: 1,
      }),
    ).toThrow();
  });
});

describe("wire version 2 is strict (NIP §2, D1/D2)", () => {
  const emptyProfile = { about: "", skills: [], looking_for: "", links: [] };
  const validJoin = { v: PROTOCOL_VERSION, name: "Bob" };

  it("PROTOCOL_VERSION is 2 and its tag is \"2\"", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(PROTOCOL_VERSION_TAG).toBe("2");
  });

  it("rejects a v:1 payload (no forward-tolerant parse anymore)", () => {
    expect(() => joinRequestContentSchema.parse({ v: 1, name: "Bob" })).toThrow();
    expect(() =>
      profileSubmissionContentSchema.parse({ v: 1, profile: emptyProfile, media: [] }),
    ).toThrow();
  });

  it("rejects a v:3 payload and classifies it as a newer version", () => {
    expect(() => joinRequestContentSchema.parse({ v: 3, name: "Bob" })).toThrow();
    expect(isNewerProtocolVersion({ v: 3, name: "Bob" })).toBe(true);
    expect(isNewerProtocolVersion({ v: 2, name: "Bob" })).toBe(false);
    expect(isNewerProtocolVersion({ v: 1, name: "Bob" })).toBe(false);
    expect(isNewerProtocolVersion({ name: "Bob" })).toBe(false);
  });

  it("readPayloadVersion extracts only integer v", () => {
    expect(readPayloadVersion({ v: 2 })).toBe(2);
    expect(readPayloadVersion({ v: "2" })).toBeUndefined();
    expect(readPayloadVersion({ v: 2.5 })).toBeUndefined();
    expect(readPayloadVersion({})).toBeUndefined();
    expect(readPayloadVersion(null)).toBeUndefined();
  });

  it("parsePayloadSafe discriminates ok / newer-version / invalid", () => {
    const ok = parsePayloadSafe(joinRequestContentSchema, validJoin);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.name).toBe("Bob");

    const newer = parsePayloadSafe(joinRequestContentSchema, { v: 5, name: "Bob" });
    expect(newer.ok).toBe(false);
    if (!newer.ok) {
      expect(newer.reason).toBe("newer-version");
      if (newer.reason === "newer-version") expect(newer.version).toBe(5);
    }

    // v:2 but structurally broken → invalid, not newer-version.
    const bad = parsePayloadSafe(joinRequestContentSchema, { v: 2 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid");
  });

  it("parsePayload throws NewerProtocolVersionError for a future payload", () => {
    expect(() => parsePayload(joinRequestContentSchema, { v: 9, name: "Bob" })).toThrow(
      NewerProtocolVersionError,
    );
    try {
      parsePayload(joinRequestContentSchema, { v: 9, name: "Bob" });
    } catch (e) {
      expect(e).toBeInstanceOf(NewerProtocolVersionError);
      expect((e as NewerProtocolVersionError).newerVersion).toBe(9);
    }
    // A v:2-but-malformed payload throws the ZodError, not the version error.
    expect(() => parsePayload(joinRequestContentSchema, { v: 2 })).not.toThrow(
      NewerProtocolVersionError,
    );
  });

  it("public-event v tag helpers gate on exactly \"2\"", () => {
    expect(hasCurrentVersionTag([["v", "2"]])).toBe(true);
    expect(hasCurrentVersionTag([["v", "1"]])).toBe(false);
    expect(hasCurrentVersionTag([["v", "3"]])).toBe(false);
    expect(hasCurrentVersionTag([["d", "x"]])).toBe(false); // absent
    expect(isNewerVersionTag([["v", "3"]])).toBe(true);
    expect(isNewerVersionTag([["v", "2"]])).toBe(false);
    expect(isNewerVersionTag([["v", "1"]])).toBe(false);
    expect(readEventVersionTag([["v", "7"]])).toBe(7);
    expect(readEventVersionTag([["v", "x"]])).toBeUndefined();
  });
});

describe("media descriptor tightening (NIP §8, v2)", () => {
  it("rejects size 0 (a real encrypted blob is ≥ 1 byte)", () => {
    expect(() => mediaDescriptorSchema.parse({ ...descriptor, size: 0 })).toThrow();
    // size 1 is the new floor and parses.
    expect(mediaDescriptorSchema.parse({ ...descriptor, size: 1 }).size).toBe(1);
  });

  it("requires duration for audio/* and video/* media", () => {
    const { duration: _drop, ...noDuration } = descriptor;
    // video/* without duration → rejected.
    expect(() =>
      mediaDescriptorSchema.parse({ ...noDuration, m: "video/webm" }),
    ).toThrow(/duration/);
    // audio/* without duration → rejected.
    expect(() =>
      mediaDescriptorSchema.parse({ ...noDuration, m: "audio/webm" }),
    ).toThrow(/duration/);
    // a non-a/v mime may still omit duration.
    expect(
      mediaDescriptorSchema.parse({ ...noDuration, m: "image/png" }).m,
    ).toBe("image/png");
    // a/v WITH duration parses.
    expect(
      mediaDescriptorSchema.parse({ ...noDuration, m: "video/webm", duration: 12 }).duration,
    ).toBe(12);
  });
});

describe("21608 correction overrides are bounded (NIP §8, v2)", () => {
  const coordinate = "31923:" + hex + ":ev";

  it("rejects an oversized override summary (> MAX_ABOUT)", () => {
    expect(() =>
      profileCorrectionContentSchema.parse({
        v: 2,
        a: coordinate,
        overrides: { summary: "x".repeat(MAX_ABOUT + 1) },
      }),
    ).toThrow();
  });

  it("rejects too many override list entries and over-long items", () => {
    expect(() =>
      profileCorrectionContentSchema.parse({
        v: 2,
        a: coordinate,
        overrides: { skills: Array(MAX_SKILLS + 1).fill("s") },
      }),
    ).toThrow();
    expect(() =>
      profileCorrectionContentSchema.parse({
        v: 2,
        a: coordinate,
        overrides: { interests: ["x".repeat(MAX_SKILL + 1)] },
      }),
    ).toThrow();
  });

  it("accepts a correction within the ai_profile bounds", () => {
    const ok = profileCorrectionContentSchema.parse({
      v: 2,
      a: coordinate,
      rev: 0,
      overrides: {
        summary: "x".repeat(MAX_ABOUT),
        skills: Array(MAX_SKILLS).fill("s".repeat(MAX_SKILL)),
      },
    });
    expect(ok.overrides?.skills).toHaveLength(MAX_SKILLS);
  });
});

describe("talk sources: recording/upload (Blossom) vs external URL (NIP §8/§11, v2)", () => {
  async function talkMedia() {
    const { descriptor } = await encryptMedia({
      kind: "talk",
      data: crypto.getRandomValues(new Uint8Array(4096)),
      mime: "video/webm",
      duration: 120,
      urls: ["https://blossom.example/talk.bin"],
    });
    return descriptor;
  }
  const base = { v: 2 as const, a: "31600:abcd:my-event", talk_d: "keynote", title: "Keynote" };

  it("accepts a Blossom-media talk and defaults process_for_matching to false", async () => {
    const parsed = talkSubmissionContentSchema.parse({ ...base, media: await talkMedia() });
    expect(parsed.process_for_matching).toBe(false);
    expect(parsed.external_url).toBeUndefined();
  });

  it("accepts an external YouTube talk with no media", () => {
    const parsed = talkSubmissionContentSchema.parse({
      ...base,
      external_url: "https://www.youtube.com/watch?v=abc123",
      external_kind: "youtube",
      source_type: "external",
    });
    expect(parsed.external_kind).toBe("youtube");
    expect(parsed.media).toBeUndefined();
  });

  it("accepts an external direct-mp4 talk", () => {
    const parsed = talkSubmissionContentSchema.parse({
      ...base,
      external_url: "https://cdn.example/talk.mp4",
      external_kind: "video",
      source_type: "external",
    });
    expect(parsed.external_kind).toBe("video");
  });

  it("rejects a talk with NEITHER media nor external_url", () => {
    expect(() => talkSubmissionContentSchema.parse({ ...base })).toThrow();
  });

  it("rejects a talk with BOTH media and external_url", async () => {
    const media = await talkMedia();
    expect(() =>
      talkSubmissionContentSchema.parse({
        ...base,
        media,
        external_url: "https://cdn.example/talk.mp4",
        external_kind: "video",
      }),
    ).toThrow();
  });

  it("rejects an external_url without external_kind", () => {
    expect(() =>
      talkSubmissionContentSchema.parse({ ...base, external_url: "https://cdn.example/talk.mp4" }),
    ).toThrow();
  });

  it("rejects a non-https external_url", () => {
    expect(() =>
      talkSubmissionContentSchema.parse({
        ...base,
        external_url: "http://cdn.example/talk.mp4",
        external_kind: "video",
      }),
    ).toThrow();
  });

  it("published talk content (31610) accepts an external URL too", () => {
    const parsed = talkContentSchema.parse({
      v: 2,
      pubkey: "a".repeat(64),
      talk_d: "keynote",
      title: "Keynote",
      external_url: "https://www.youtube.com/watch?v=abc123",
      external_kind: "youtube",
      source_type: "external",
      lang: "en",
      revision: 0,
      status: "published",
      published_at: 1_800_000_000,
    });
    expect(parsed.media).toBeUndefined();
    expect(parsed.external_url).toContain("youtube");
  });
});
