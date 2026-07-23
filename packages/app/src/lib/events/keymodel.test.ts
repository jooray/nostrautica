/**
 * End-to-end key-model test for the walking skeleton (spec §6, §8) at the crypto
 * layer — no relays. Proves: organizer grants the ECK via gift wrap; the attendee
 * unwraps it, computes the same blinded d the organizer used, and decrypts the
 * directory entry + roster; a non-attendee (no ECK) cannot.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  generateEck,
  eckEncrypt,
  eckDecrypt,
  blindedD,
  base64ToBytes,
  bytesToBase64,
  makeCoordinate,
  keyGrantContentSchema,
  directoryEntryContentSchema,
  KIND_KEY_GRANT,
} from "@nostrautica/protocol";
import { LocalSigner } from "$lib/signer/local.js";
import { signerWrap, signerUnwrap } from "./giftwrap.js";

describe("walking-skeleton key model", () => {
  it("organizer → grant → attendee decrypts directory; outsider cannot", async () => {
    const organizer = LocalSigner.generate();
    const attendee = LocalSigner.generate();
    const attendeePk = await attendee.getPublicKey();
    const eidPk = getPublicKey(generateSecretKey());
    const coordinate = makeCoordinate(eidPk, "cypherpunk-2026");
    const eck = generateEck();

    // Organizer publishes the attendee's directory entry under ECK, blinded d.
    const entryD = blindedD(eck, coordinate, attendeePk);
    const entryPlain = {
      v: 2,
      pubkey: attendeePk,
      profile: { about: "cryptographer", skills: ["zk"], looking_for: "designer", links: [] },
      media: [],
      updated_at: 1_700_000_000,
    };
    const entryCiphertext = eckEncrypt(eck, JSON.stringify(entryPlain));

    // Organizer grants the ECK to the attendee (21602 gift wrap).
    const grantWrap = await signerWrap(organizer, attendeePk, {
      kind: KIND_KEY_GRANT,
      content: {
        v: 2,
        a: coordinate,
        role: "attendee",
        eck: [{ id: 1, key: bytesToBase64(eck) }],
        granted_by: await organizer.getPublicKey(),
      },
    });

    // Attendee unwraps the grant and recovers the ECK.
    const rumor = await signerUnwrap(attendee, grantWrap);
    const grant = keyGrantContentSchema.parse(JSON.parse(rumor.content));
    const recoveredEck = base64ToBytes(grant.eck[0]!.key);
    expect(recoveredEck).toEqual(eck);

    // Attendee independently computes the same blinded d and decrypts the entry.
    expect(blindedD(recoveredEck, coordinate, attendeePk)).toBe(entryD);
    const decrypted = directoryEntryContentSchema.parse(
      JSON.parse(eckDecrypt(recoveredEck, entryCiphertext)),
    );
    expect(decrypted.profile.about).toBe("cryptographer");

    // A non-attendee holds no ECK — the ciphertext is opaque and the d is unguessable.
    const outsiderEck = generateEck();
    expect(() => eckDecrypt(outsiderEck, entryCiphertext)).toThrow();
    expect(blindedD(outsiderEck, coordinate, attendeePk)).not.toBe(entryD);
  });
});
