package today.cypherpunk.nostrautica.protocol

/** Encrypted media on Blossom (media.ts, spec §6.2). */
object Media {
    class Encrypted(val ciphertext: ByteArray, val descriptor: MediaDescriptor)

    fun encrypt(kind: String, data: ByteArray, mime: String, duration: Double?, urls: List<String> = emptyList()): Encrypted {
        val c = ProtocolCrypto.aesGcmEncrypt(data)
        val d = MediaDescriptor(
            kind = kind,
            url = urls,
            x = Bytes.sha256Hex(c.ciphertext),
            ox = Bytes.sha256Hex(data),
            size = c.ciphertext.size.toLong(),
            m = mime,
            duration = duration,
            decryptionKey = Bytes.toBase64(c.key),
            decryptionNonce = Bytes.toBase64(c.nonce),
        )
        d.validateDraft()
        return Encrypted(c.ciphertext, d)
    }

    /** Verify size, then `x`, decrypt, then `ox` — in that order, as media.ts does. */
    fun decrypt(d: MediaDescriptor, ciphertext: ByteArray): ByteArray {
        require(ciphertext.size.toLong() == d.size) { "ciphertext is ${ciphertext.size} bytes, descriptor declares ${d.size} (size)" }
        require(Bytes.sha256Hex(ciphertext) == d.x) { "ciphertext sha256 mismatch (x)" }
        val pt = ProtocolCrypto.aesGcmDecrypt(ciphertext, Bytes.fromBase64(d.decryptionKey), Bytes.fromBase64(d.decryptionNonce))
        require(Bytes.sha256Hex(pt) == d.ox) { "plaintext sha256 mismatch (ox)" }
        return pt
    }

    /** "Fresh copy": re-key a blob so its hash no longer links the attendee across events. */
    fun freshCopy(d: MediaDescriptor, ciphertext: ByteArray, newUrls: List<String> = emptyList()): Encrypted =
        encrypt(d.kind, decrypt(d, ciphertext), d.m, d.duration, newUrls.ifEmpty { d.url })
}
