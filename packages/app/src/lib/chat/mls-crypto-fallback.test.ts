/**
 * Regression test for the old-Chromium chat failure:
 * "Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name".
 *
 * The Marmot ciphersuite (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) asks
 * WebCrypto for Ed25519 signatures and an X25519 KEM. Those algorithm names only
 * exist in Chrome/Edge ≥ 137 / ≥ 133 (Firefox ≥ 129/130, Safari ≥ 17): older
 * Chromium builds and older Android WebViews HAVE `crypto.subtle` but throw
 * "Unrecognized name" for them, which previously made chat setup fail before the
 * device could even publish its kind-30443 key package.
 *
 * The vendored ts-mls now probes for real support and falls back to pure-JS
 * (@noble/curves Ed25519, @hpke/dhkem-x25519). This stubs `crypto.subtle` to
 * reject exactly those two algorithm names — every other operation passes through
 * to the real implementation — and asserts the ciphersuite still fully works, and
 * that the fallback (not the blocked native path) is what ran.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCryptoProvider, ciphersuites } from "ts-mls";

const CS = ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const BLOCKED = new Set(["Ed25519", "X25519"]);

function algName(alg: unknown): string | undefined {
  return typeof alg === "string" ? alg : (alg as { name?: string } | null | undefined)?.name;
}

/**
 * Replace `globalThis.crypto` with one whose `subtle` throws the exact old-browser
 * error for Ed25519/X25519 and delegates everything else (AES-GCM, HKDF, SHA-2,
 * getRandomValues) to the real implementation.
 */
function stubOldBrowserCrypto(): void {
  const realSubtle = globalThis.crypto.subtle;
  const subtle = new Proxy(realSubtle, {
    get(target, prop) {
      const orig = Reflect.get(target, prop);
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]) => {
        // importKey(format, keyData, algorithm, …); the rest take the algorithm first.
        const alg = args[prop === "importKey" ? 2 : 0];
        const name = algName(alg);
        if (name && BLOCKED.has(name)) {
          throw new DOMException("Algorithm: Unrecognized name", "NotSupportedError");
        }
        return Reflect.apply(orig, target, args);
      };
    },
  });
  vi.stubGlobal(
    "crypto",
    new Proxy(globalThis.crypto, {
      get(target, prop) {
        if (prop === "subtle") return subtle;
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
}

/** Exercise every patched primitive of the ciphersuite end to end. */
async function expectCiphersuiteWorks(): Promise<{ signKeyLength: number }> {
  const impl = await defaultCryptoProvider.getCiphersuiteImpl(CS);

  // Ed25519 signature round trip (makeNobleSignatureImpl).
  const { signKey, publicKey } = await impl.signature.keygen();
  const message = new TextEncoder().encode("marmot");
  const signature = await impl.signature.sign(signKey, message);
  expect(await impl.signature.verify(publicKey, message, signature)).toBe(true);
  expect(await impl.signature.verify(publicKey, new TextEncoder().encode("forged"), signature)).toBe(
    false,
  );

  // X25519 HPKE round trip (makeDhKem): seal with the public key, open with the
  // private key. With the stub active this only succeeds if the pure-JS KEM ran.
  const { privateKey, publicKey: kemPublicKey } = await impl.hpke.generateKeyPair();
  const info = new TextEncoder().encode("info");
  const aad = new TextEncoder().encode("aad");
  const { ct, enc } = await impl.hpke.seal(kemPublicKey, message, info, aad);
  expect(new Uint8Array(await impl.hpke.open(privateKey, enc, ct, info, aad))).toEqual(message);

  return { signKeyLength: signKey.length };
}

describe("ts-mls default crypto provider — WebCrypto capability fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to pure-JS when WebCrypto lacks Ed25519/X25519 (old Chromium/Android WebView)", async () => {
    stubOldBrowserCrypto();
    const { signKeyLength } = await expectCiphersuiteWorks();
    // noble keygen returns the raw 32-byte seed; the WebCrypto path would return a
    // 48-byte PKCS8 blob — the length proves the fallback produced this key.
    expect(signKeyLength).toBe(32);
  });

  it("prefers native WebCrypto where the algorithms are supported (modern browsers unchanged)", async () => {
    const { signKeyLength } = await expectCiphersuiteWorks();
    // 48-byte PKCS8 export: the native WebCrypto path ran, as before the patch.
    expect(signKeyLength).toBe(48);
  });
});
