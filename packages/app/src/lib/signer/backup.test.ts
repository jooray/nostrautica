import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  toNsec,
  fromNsec,
  toNcryptsec,
  fromNcryptsec,
  isNcryptsec,
  loginLink,
  mailtoBackup,
  importCredential,
} from "./backup.js";
import { bytesToHex } from "@nostrautica/protocol";

describe("nsec round-trip", () => {
  it("encodes and decodes", () => {
    const sk = generateSecretKey();
    expect(fromNsec(toNsec(sk))).toEqual(sk);
  });
  it("rejects non-nsec", () => {
    expect(() => fromNsec("npub1abc")).toThrow();
  });
});

describe("NIP-49 ncryptsec", () => {
  it("round-trips with the passphrase", () => {
    const sk = generateSecretKey();
    const enc = toNcryptsec(sk, "hunter2");
    expect(isNcryptsec(enc)).toBe(true);
    expect(fromNcryptsec(enc, "hunter2")).toEqual(sk);
  });
  it("fails with the wrong passphrase", () => {
    const enc = toNcryptsec(generateSecretKey(), "right");
    expect(() => fromNcryptsec(enc, "wrong")).toThrow();
  });
});

describe("backup links", () => {
  const sk = generateSecretKey();
  it("loginLink carries the nsec in the fragment", () => {
    const link = loginLink("https://app.example", sk);
    expect(link).toContain("/#/login?nsec=");
    expect(link).toContain(toNsec(sk));
    // No trailing double-slash regardless of base URL shape.
    expect(loginLink("https://app.example/", sk)).toBe(link);
  });
  it("mailtoBackup embeds the login link and a not-confidential warning", () => {
    const m = mailtoBackup("https://app.example", sk);
    expect(m.startsWith("mailto:?subject=")).toBe(true);
    expect(decodeURIComponent(m)).toContain(toNsec(sk));
    expect(decodeURIComponent(m).toLowerCase()).toContain("not confidential");
  });
});

describe("importCredential", () => {
  const sk = generateSecretKey();
  it("accepts nsec", () => {
    expect(getPublicKey(importCredential(toNsec(sk)))).toBe(getPublicKey(sk));
  });
  it("accepts hex", () => {
    expect(importCredential(bytesToHex(sk))).toEqual(sk);
  });
  it("accepts ncryptsec + passphrase", () => {
    const enc = toNcryptsec(sk, "pw");
    expect(importCredential(enc, "pw")).toEqual(sk);
  });
  it("requires a passphrase for ncryptsec", () => {
    expect(() => importCredential(toNcryptsec(sk, "pw"))).toThrow(/passphrase/);
  });
  it("rejects garbage", () => {
    expect(() => importCredential("hello world")).toThrow();
  });
});
