import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
const { signerWrap, publishAccountGiftWrap } = vi.hoisted(() => ({
  signerWrap: vi.fn(),
  publishAccountGiftWrap: vi.fn(),
}));
vi.mock("$lib/events/giftwrap.js", () => ({ signerWrap }));
vi.mock("$lib/nostr/giftwrap-routing.js", () => ({ publishAccountGiftWrap }));

import {
  buildChatKeyAttestationContent,
  sendChatKeyAttestation,
  verifyChatKeyAttestation,
} from "./attest.js";
import {
  KIND_CHAT_KEY_ATTESTATION,
  makeChatDeviceProof,
  verifyChatDeviceProof,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";

const coordinate = "31923:" + "a".repeat(64) + ":ev";
const account = "c".repeat(64);
const deviceSk = generateSecretKey();
const chatPubkey = getPublicKey(deviceSk);
const createdAt = 1_700_000_000;
const proof = makeChatDeviceProof(deviceSk, coordinate, account, createdAt);

describe("chat device attestation (21607 v2)", () => {
  beforeEach(() => {
    signerWrap.mockReset().mockResolvedValue({ kind: 1059 });
    publishAccountGiftWrap.mockReset().mockResolvedValue(true);
  });

  it("builds a valid add attestation with proof, label, and client_id", () => {
    const c = buildChatKeyAttestationContent(coordinate, {
      op: "add",
      chatPubkey,
      clientId: "web-1",
      label: "Chrome on macOS",
      proof,
    });
    expect(c).toEqual({
      v: 2,
      a: coordinate,
      op: "add",
      chat_pubkey: chatPubkey,
      label: "Chrome on macOS",
      client_id: "web-1",
      proof,
    });
  });

  it("the built proof verifies as possession of the device key (NIP §10.2)", () => {
    expect(verifyChatDeviceProof(proof, coordinate, account, chatPubkey, createdAt)).toBe(true);
    // A proof over a different created_at does not verify (replay guard).
    expect(verifyChatDeviceProof(proof, coordinate, account, chatPubkey, createdAt + 1)).toBe(false);
  });

  it("an add without proof or without label is rejected by the schema", () => {
    expect(() => buildChatKeyAttestationContent(coordinate, { op: "add", chatPubkey, label: "x" })).toThrow();
    expect(() => buildChatKeyAttestationContent(coordinate, { op: "add", chatPubkey, proof })).toThrow();
  });

  it("builds a revoke attestation with no proof/label", () => {
    const c = buildChatKeyAttestationContent(coordinate, { op: "revoke", chatPubkey });
    expect(c).toEqual({ v: 2, a: coordinate, op: "revoke", chat_pubkey: chatPubkey });
    expect("proof" in c).toBe(false);
    expect("label" in c).toBe(false);
  });

  it("verify parses a well-formed rumor and enforces the kind", () => {
    const content = buildChatKeyAttestationContent(coordinate, { op: "add", chatPubkey, label: "d", proof });
    const rumor = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify(content) };
    expect(verifyChatKeyAttestation(rumor)).toEqual(content);
    // wrong kind is rejected
    expect(() => verifyChatKeyAttestation({ ...rumor, kind: 1 })).toThrow();
  });

  it("verify enforces the expected account (seal author binding)", () => {
    const content = buildChatKeyAttestationContent(coordinate, { op: "add", chatPubkey, label: "d", proof });
    const rumor = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify(content) };
    expect(verifyChatKeyAttestation(rumor, account)).toEqual(content);
    expect(() => verifyChatKeyAttestation(rumor, "d".repeat(64))).toThrow(/expected account/);
  });

  it("verify rejects a strict-schema violation (unknown op / extra field)", () => {
    const bad = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify({ v: 2, a: coordinate, op: "swap", chat_pubkey: chatPubkey }) };
    expect(() => verifyChatKeyAttestation(bad)).toThrow();
    const extra = { kind: KIND_CHAT_KEY_ATTESTATION, pubkey: account, content: JSON.stringify({ v: 2, a: coordinate, op: "add", chat_pubkey: chatPubkey, label: "d", proof, rogue: true }) };
    expect(() => verifyChatKeyAttestation(extra)).toThrow();
  });

  it("routes the attestation wrap as an account-addressed coordinator message", async () => {
    const coordinator = "d".repeat(64);
    const relays = ["wss://event-relay.example"];
    const signer = { getPublicKey: async () => account } as AppSigner;
    const ctx = { coordinate, config: { coordinator, relays } } as unknown as EventContext;

    await sendChatKeyAttestation(signer, ctx, {
      op: "add",
      chatPubkey,
      label: "Browser",
      deviceSecretKey: deviceSk,
    });

    expect(signerWrap).toHaveBeenCalledWith(signer, coordinator, expect.objectContaining({
      kind: KIND_CHAT_KEY_ATTESTATION,
    }));
    expect(publishAccountGiftWrap).toHaveBeenCalledWith({ kind: 1059 }, coordinator, relays);
  });
});
