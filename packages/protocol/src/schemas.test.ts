import { describe, it, expect } from "vitest";
import {
  mediaDescriptorSchema,
  joinRequestContentSchema,
  profileSubmissionContentSchema,
  keyGrantContentSchema,
  coordinatorGrantContentSchema,
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
  chatKeyAttestationContentSchema,
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
      v: 1,
      name: "Alice",
      message: "hi",
      rsvp_public: false,
    }));

  it("21601 profile submission", () =>
    roundTrips(profileSubmissionContentSchema, {
      v: 1,
      profile: { about: "dev", skills: ["rust"], looking_for: "cofounder", links: [] },
      media: [descriptor],
    }));

  it("21602 key grant", () =>
    roundTrips(keyGrantContentSchema, {
      v: 1,
      a: "31923:" + hex + ":ev",
      role: "attendee",
      eck: [{ id: 1, key: b64_32 }],
      granted_by: hex,
    }));

  it("21603 coordinator grant", () =>
    roundTrips(coordinatorGrantContentSchema, {
      v: 1,
      a: "31923:" + hex + ":ev",
      inbox_nsec: hex,
      eck: [{ id: 1, key: b64_32 }],
      config_relays: ["wss://relay.example"],
    }));

  it("21604 admin command", () =>
    roundTrips(adminCommandContentSchema, {
      v: 1,
      a: "31923:" + hex + ":ev",
      cmd: "revoke",
      args: { pubkey: hex },
    }));

  it("31601 invite list", () =>
    roundTrips(inviteListContentSchema, {
      v: 1,
      invites: [{ h: hex, label: "vip-1" }],
    }));

  it("31602 my profile (event + library variants)", () => {
    roundTrips(myProfileContentSchema, {
      v: 1,
      a: "31923:" + hex + ":ev",
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [descriptor],
    });
    roundTrips(myProfileContentSchema, { v: 1, a: null, media: [descriptor] });
  });

  it("31603 directory entry", () =>
    roundTrips(directoryEntryContentSchema, {
      v: 1,
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
      v: 1,
      eck_current: 1,
      attendees: [{ pubkey: hex, d: "deadbeef", role: "attendee" }],
    }));

  it("31604 roster carries an optional Marmot chat_pubkey (§4.4)", () =>
    roundTrips(rosterContentSchema, {
      v: 1,
      eck_current: 2,
      attendees: [
        { pubkey: hex, d: "deadbeef", role: "attendee", chat_pubkey: "b".repeat(64) },
        { pubkey: "c".repeat(64), d: "cafe", role: "organizer" }, // no chat key
      ],
    }));

  it("21607 chat-key attestation round-trips (add + revoke)", () => {
    roundTrips(chatKeyAttestationContentSchema, {
      v: 1,
      a: "31923:" + hex + ":ev",
      op: "add",
      chat_pubkey: "b".repeat(64),
      client_id: "device-1",
    });
    roundTrips(chatKeyAttestationContentSchema, {
      v: 1,
      a: "31923:" + hex + ":ev",
      op: "revoke",
      chat_pubkey: "b".repeat(64),
    });
  });

  it("21607 rejects an unknown op and an unexpected field (strict)", () => {
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 1,
        a: "31923:" + hex + ":ev",
        op: "delete", // not add/revoke
        chat_pubkey: "b".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      chatKeyAttestationContentSchema.parse({
        v: 1,
        a: "31923:" + hex + ":ev",
        op: "add",
        chat_pubkey: "b".repeat(64),
        rogue: true, // strict → rejected
      }),
    ).toThrow();
  });

  it("31605 match list", () =>
    roundTrips(matchListContentSchema, {
      v: 1,
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
      v: 1,
      computed_at: 1_700_000_000,
      pairs: [{ a: hex, b: "b".repeat(64), score: 0.5 }],
    }));

  it("30078 per-event settings", () =>
    roundTrips(perEventSettingsSchema, {
      v: 1,
      favorites: [hex],
      want_to_meet: [],
      met: [],
      notes: { [hex]: "met at coffee" },
    }));

  it("30078 event keys backup", () =>
    roundTrips(eventKeysBackupSchema, {
      v: 1,
      eid_nsec: hex,
      einbox_nsec: "b".repeat(64),
      eck: [{ id: 1, key: b64_32 }],
    }));

  it("30078 event keys backup with coordinate", () =>
    roundTrips(eventKeysBackupSchema, {
      v: 1,
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
        v: 1,
        a: "x",
        role: "attendee",
        eck: [],
        granted_by: "nothex",
      }),
    ).toThrow();
  });

  it("rejects an unknown media kind", () => {
    expect(() => mediaDescriptorSchema.parse({ ...descriptor, kind: "audio" })).toThrow();
  });

  it("applies defaults for optional fields", () => {
    const parsed = joinRequestContentSchema.parse({ v: 1, name: "Bob" });
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
        v: 1,
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
        v: 1,
        a: "31923:" + hex + ":ev",
        inbox_nsec: "not-a-hex-secret-key",
        eck: [{ id: 1, key: b64_32 }],
        config_relays: ["wss://relay.example"],
      }),
    ).toThrow();
  });

  it("round-trips the 21606 coordinator status payload (Q12)", () => {
    roundTrips(coordinatorStatusContentSchema, {
      v: 1,
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
      v: 1,
      profile: { about: "dev", skills: ["rust"], looking_for: "cofounder", links: [] },
      media: [],
      intro_text: "I write Rust and care about privacy. Looking to meet designers.",
    }));

  it("21601 submission caps intro_text at MAX_INTRO_TEXT", () =>
    expect(() =>
      profileSubmissionContentSchema.parse({
        v: 1,
        profile: { about: "", skills: [], looking_for: "", links: [] },
        media: [],
        intro_text: "x".repeat(2001),
      }),
    ).toThrow());

  it("MediaTranscript round-trips and is strict", () => {
    roundTrips(mediaTranscriptSchema, transcript);
    expect(() => mediaTranscriptSchema.parse({ ...transcript, evil: 1 })).toThrow();
    expect(() => mediaTranscriptSchema.parse({ ...transcript, source: "guess" })).toThrow();
  });

  it("31603 directory entry round-trips with transcripts + intro_text", () =>
    roundTrips(directoryEntryContentSchema, {
      v: 1,
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
        v: 1,
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
      v: 1,
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
      v: 1,
      a: coordinate,
      overrides: { summary: "I actually build hardware, not software.", skills: ["soldering"] },
    }));

  it("a hide-everything correction round-trips", () =>
    roundTrips(profileCorrectionContentSchema, { v: 1, a: coordinate, hidden: true }));

  it("hidden_fields + report round-trip", () =>
    roundTrips(profileCorrectionContentSchema, {
      v: 1,
      a: coordinate,
      hidden_fields: ["interests", "seeks"],
      report: "The AI invented interests I never mentioned.",
    }));

  it("rejects an unknown ai_profile field in hidden_fields", () =>
    expect(() =>
      profileCorrectionContentSchema.parse({ v: 1, a: coordinate, hidden_fields: ["about"] }),
    ).toThrow());

  it("caps the report length at MAX_INTRO_TEXT", () =>
    expect(() =>
      profileCorrectionContentSchema.parse({ v: 1, a: coordinate, report: "x".repeat(2001) }),
    ).toThrow());

  it("31603 directory entry round-trips with ai_profile_edited", () =>
    roundTrips(directoryEntryContentSchema, {
      v: 1,
      pubkey: hex,
      profile: { about: "x", skills: [], looking_for: "", links: [] },
      media: [],
      ai_profile: { summary: "s", skills: [], interests: [], offers: [], seeks: [] },
      ai_profile_edited: true,
      updated_at: 1_700_000_000,
    }));
});
