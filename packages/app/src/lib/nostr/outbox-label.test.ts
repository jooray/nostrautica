/**
 * Audit DS41-021: the outbox showed "Item (kind 1059)" / "Položka (typ 21601)",
 * and a single tap on Discard deleted a PENDING item, one that was only waiting
 * for connectivity, with no confirmation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  KIND_GIFT_WRAP,
  KIND_PROFILE,
  KIND_CONTACTS,
  KIND_DELETION,
  KIND_CALENDAR_RSVP,
  KIND_ROSTER,
  KIND_LONGFORM,
} from "@nostrautica/protocol";
import { outboxKindKey } from "./outbox-label.js";
import { messages } from "$lib/i18n/messages.js";

describe("outboxKindKey", () => {
  it("names the kinds a member actually queues", () => {
    expect(outboxKindKey(KIND_GIFT_WRAP)).toBe("outbox.kind.message");
    expect(outboxKindKey(KIND_PROFILE)).toBe("outbox.kind.profile");
    expect(outboxKindKey(KIND_CONTACTS)).toBe("outbox.kind.follows");
    expect(outboxKindKey(KIND_DELETION)).toBe("outbox.kind.deletion");
    expect(outboxKindKey(KIND_CALENDAR_RSVP)).toBe("outbox.kind.rsvp");
    expect(outboxKindKey(KIND_ROSTER)).toBe("outbox.kind.event");
    expect(outboxKindKey(KIND_LONGFORM)).toBe("outbox.kind.post");
    expect(outboxKindKey(424242)).toBe("outbox.kind.other");
  });

  it("every label it can return is translated, and none shows a kind number", () => {
    const kinds = [KIND_GIFT_WRAP, KIND_PROFILE, KIND_CONTACTS, KIND_DELETION, KIND_CALENDAR_RSVP, KIND_ROSTER, KIND_LONGFORM, 10002, 30078, 1, 424242];
    for (const loc of Object.keys(messages) as (keyof typeof messages)[]) {
      for (const k of kinds) {
        const text = (messages[loc] as Record<string, string>)[outboxKindKey(k)];
        expect(text, `${loc} ${k}`).toBeTruthy();
        expect(text).not.toMatch(/\{kind\}|\d{2,}/);
      }
    }
  });
});

describe("OutboxIndicator", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../components/OutboxIndicator.svelte"),
    "utf8",
  );

  it("never discards on a single tap", () => {
    expect(src).not.toMatch(/onclick=\{\(\) => void outbox\.discard\(/);
    expect(src).toMatch(/if \(armed !== id\) \{\s*armed = id;\s*return;/);
  });

  it("keeps the raw error and kind number behind a disclosure", () => {
    expect(src).toMatch(/<details[^>]*>[\s\S]*?item\.lastError[\s\S]*?<\/details>/);
  });
});
