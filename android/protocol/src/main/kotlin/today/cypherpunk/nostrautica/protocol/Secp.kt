package today.cypherpunk.nostrautica.protocol

import fr.acinq.secp256k1.Secp256k1

/**
 * BIP-340 Schnorr and ECDH over libsecp256k1 (ACINQ's secp256k1-kmp, the native
 * library also used by Bitcoin wallets). Keys are 32-byte secrets and 32-byte
 * x-only public keys, as everywhere in Nostr.
 */
object Secp {
    fun isValidSecret(sk: ByteArray): Boolean =
        sk.size == 32 && runCatching { Secp256k1.secKeyVerify(sk) }.getOrDefault(false)

    fun generateSecret(): ByteArray {
        while (true) {
            val sk = Bytes.random(32)
            if (isValidSecret(sk)) return sk
        }
    }

    /** x-only public key of a secret key. */
    fun pubkey(sk: ByteArray): ByteArray {
        require(sk.size == 32) { "secret key must be 32 bytes" }
        val full = Secp256k1.pubkeyCreate(sk) // 65-byte uncompressed
        return full.copyOfRange(1, 33)
    }

    fun pubkeyHex(sk: ByteArray): String = Bytes.toHex(pubkey(sk))

    fun sign(message32: ByteArray, sk: ByteArray): ByteArray {
        require(message32.size == 32) { "schnorr message must be 32 bytes" }
        return Secp256k1.signSchnorr(message32, sk, Bytes.random(32))
    }

    fun verify(sig: ByteArray, message32: ByteArray, pubkey: ByteArray): Boolean =
        runCatching {
            sig.size == 64 && message32.size == 32 && pubkey.size == 32 &&
                Secp256k1.verifySchnorr(sig, message32, pubkey)
        }.getOrDefault(false)

    /**
     * The unhashed x coordinate of sk·P, which NIP-44 feeds into HKDF. The x-only
     * pubkey is lifted to its even-y point, as BIP-340 defines.
     */
    fun sharedX(sk: ByteArray, xOnlyPubkey: ByteArray): ByteArray {
        require(xOnlyPubkey.size == 32) { "pubkey must be 32 bytes" }
        val compressed = byteArrayOf(0x02) + xOnlyPubkey
        val point = Secp256k1.pubKeyTweakMul(Secp256k1.pubkeyParse(compressed), sk)
        val uncompressed = Secp256k1.pubkeyParse(point) // normalizes to 65-byte form
        return uncompressed.copyOfRange(1, 33)
    }
}
