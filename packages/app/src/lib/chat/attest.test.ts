import { describe, it, expect } from "vitest";
import { buildChatKeyAttestationContent, verifyChatKeyAttestation } from "./attest.js";
import { KIND_CHAT_KEY_ATTESTATION } from "@nostrautica/protocol";

const coordinate = "31923:" + "a".repeat(64) + ":ev";
const chatPubkey = "b".repeat(64);
const account = "c".repeat(64);

describe("chat-key attestation (21607)", () => {
  it("builds a valid add attestation with client_id", () => {
    const c = buildChatKeyAttestationContent(coordinate, {
      op: "add",
      chatPubkey,
      clientId: "web-1",
    });
    expect(c).toEqual({ v: 1, a: coordinate, op: "add", chat_pubkey: chatPubkey, client_id: "web-1" });
  });

  it("omits client_id when not supplied", () => {
    const c = buildChatKeyAttestationContent(coordinate, { op: "revoke", chatPubkey });
    expect(c).toEqual({ v: 1, a: coordinate, op: "revoke", chat_pubkey: chatPubkey });
    expect("client_id" in c).toBe(false);
  });

  it("verify parses a well-formed rumor and enforces the kind", () => {
    const content = buildChatKeyAttestationContent(coordinate, { op: "add", chatPubkey });
    const rumor = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify(content) };
    expect(verifyChatKeyAttestation(rumor)).toEqual(content);
    // wrong kind is rejected
    expect(() => verifyChatKeyAttestation({ ...rumor, kind: 1 })).toThrow();
  });

  it("verify enforces the expected account (seal author binding)", () => {
    const content = buildChatKeyAttestationContent(coordinate, { op: "add", chatPubkey });
    const rumor = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify(content) };
    expect(verifyChatKeyAttestation(rumor, account)).toEqual(content);
    expect(() => verifyChatKeyAttestation(rumor, "d".repeat(64))).toThrow(/expected account/);
  });

  it("verify rejects a strict-schema violation (unknown op / extra field)", () => {
    const bad = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify({ v: 1, a: coordinate, op: "swap", chat_pubkey: chatPubkey }) };
    expect(() => verifyChatKeyAttestation(bad)).toThrow();
    const extra = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify({ v: 1, a: coordinate, op: "add", chat_pubkey: chatPubkey, rogue: true }) };
    expect(() => verifyChatKeyAttestation(extra)).toThrow();
  });
});
