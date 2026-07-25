import { DhkemP256HkdfSha256, DhkemX25519HkdfSha256, DhkemP521HkdfSha512, DhkemP384HkdfSha384, } from "@hpke/core";
import { DependencyError } from "../../../mlsError.js";
// NOSTRAUTICA PATCH (carried — re-apply on vendor bump, see packages/vendor/README.md):
// @hpke/core's X25519 KEM is WebCrypto-only; Chromium/WebView < 133 throws
// "Algorithm: Unrecognized name" for it. Probe for support and fall back to
// upstream's pure-JS @hpke/dhkem-x25519 (same DHKEM(X25519, HKDF-SHA256), wire
// compatible). The probe key is the X25519 base point, a known-valid public key
// (implementations may reject low-order points such as all-zero).
const X25519_PROBE_KEY = new Uint8Array([0x09, ...new Array(31).fill(0)]);
async function supportsWebCryptoX25519() {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined)
        return false;
    try {
        await subtle.importKey("raw", X25519_PROBE_KEY, { name: "X25519" }, false, []);
        return true;
    }
    catch {
        return false;
    }
}
export async function makeDhKem(kemAlg) {
    switch (kemAlg) {
        case "DHKEM-P256-HKDF-SHA256":
            return new DhkemP256HkdfSha256();
        case "DHKEM-X25519-HKDF-SHA256": {
            if (await supportsWebCryptoX25519())
                return new DhkemX25519HkdfSha256();
            try {
                const { DhkemX25519HkdfSha256: NobleDhkemX25519HkdfSha256 } = await import("@hpke/dhkem-x25519");
                return new NobleDhkemX25519HkdfSha256();
            }
            catch (err) {
                throw new DependencyError("Optional dependency '@hpke/dhkem-x25519' is not installed. Please install it to use this feature.");
            }
        }
        case "DHKEM-X448-HKDF-SHA512": {
            try {
                const { DhkemX448HkdfSha512 } = await import("@hpke/dhkem-x448");
                return new DhkemX448HkdfSha512();
            }
            catch (err) {
                throw new DependencyError("Optional dependency '@hpke/dhkem-x448' is not installed. Please install it to use this feature.");
            }
        }
        case "DHKEM-P521-HKDF-SHA512":
            return new DhkemP521HkdfSha512();
        case "DHKEM-P384-HKDF-SHA384":
            return new DhkemP384HkdfSha384();
        case "ML-KEM-512":
            try {
                const { MlKem512 } = await import("@hpke/ml-kem");
                return new MlKem512();
            }
            catch (err) {
                throw new DependencyError("Optional dependency '@hpke/ml-kem' is not installed. Please install it to use this feature.");
            }
        case "ML-KEM-768":
            try {
                const { MlKem768 } = await import("@hpke/ml-kem");
                return new MlKem768();
            }
            catch (err) {
                throw new DependencyError("Optional dependency '@hpke/ml-kem' is not installed. Please install it to use this feature.");
            }
        case "ML-KEM-1024":
            try {
                const { MlKem1024 } = await import("@hpke/ml-kem");
                return new MlKem1024();
            }
            catch (err) {
                throw new DependencyError("Optional dependency '@hpke/ml-kem' is not installed. Please install it to use this feature.");
            }
        case "X-Wing":
            try {
                const { XWing } = await import("@hpke/hybridkem-x-wing");
                return new XWing();
            }
            catch (err) {
                throw new DependencyError("Optional dependency '@hpke/hybridkem-x-wing' is not installed. Please install it to use this feature.");
            }
    }
}
//# sourceMappingURL=makeDhKem.js.map