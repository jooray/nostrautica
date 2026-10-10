package today.cypherpunk.nostrautica.protocol

/**
 * NIP-44 v2 (ChaCha20 + HMAC-SHA256, padded), plus the bounds packages/protocol
 * enforces on every path (crypto.ts): plaintext ≤ 65,535 bytes, and a payload is
 * rejected by shape before anything decodes it.
 *
 * Three ways of getting a conversation key, matching the TS helpers:
 * directed ECDH ([conversationKey]), self ([selfConversationKey]) and the ECK,
 * which IS the conversation key ([eckEncrypt]).
 */
object Nip44 {
    const val MAX_PLAINTEXT_BYTES = 65_535
    private const val MIN_CIPHERTEXT_B64 = 132
    val MAX_CIPHERTEXT_B64: Int =
        (1 + 32 + (2 + calcPaddedLen(MAX_PLAINTEXT_BYTES)) + 32 + 2) / 3 * 4
    private val SALT = Bytes.utf8("nip44-v2")
    private val B64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

    class DecryptException(message: String) : Exception(message)

    fun conversationKey(sk: ByteArray, pubkey: ByteArray): ByteArray =
        Bytes.hkdfExtract(SALT, Secp.sharedX(sk, pubkey))

    fun conversationKey(sk: ByteArray, pubkeyHex: String): ByteArray =
        conversationKey(sk, Bytes.fromHex(pubkeyHex))

    fun selfConversationKey(sk: ByteArray): ByteArray = conversationKey(sk, Secp.pubkey(sk))

    fun calcPaddedLen(len: Int): Int {
        require(len >= 1) { "expected positive integer" }
        if (len <= 32) return 32
        val nextPower = 1 shl (32 - Integer.numberOfLeadingZeros(len - 1))
        val chunk = if (nextPower <= 256) 32 else nextPower / 8
        return chunk * ((len - 1) / chunk + 1)
    }

    /** The shape test from crypto.ts `isNip44Ciphertext`: never ask a signer to decrypt junk. */
    fun isCiphertext(s: String?): Boolean =
        s != null && s.length in MIN_CIPHERTEXT_B64..MAX_CIPHERTEXT_B64 && s.length % 4 == 0 && B64.matches(s)

    fun isNip04Ciphertext(s: String?): Boolean = s != null && s.contains("?iv=")

    fun encrypt(plaintext: String, conversationKey: ByteArray, nonce: ByteArray = Bytes.random(32)): String {
        require(conversationKey.size == 32) { "conversation key must be 32 bytes" }
        require(nonce.size == 32) { "nonce must be 32 bytes" }
        val pt = Bytes.utf8(plaintext)
        require(pt.isNotEmpty()) { "NIP-44 plaintext must not be empty" }
        require(pt.size <= MAX_PLAINTEXT_BYTES) {
            "NIP-44 plaintext is ${pt.size} bytes, over the 65535-byte ceiling"
        }
        val keys = Bytes.hkdfExpand(conversationKey, nonce, 76)
        val chachaKey = keys.copyOfRange(0, 32)
        val chachaNonce = keys.copyOfRange(32, 44)
        val hmacKey = keys.copyOfRange(44, 76)
        val padded = ByteArray(2 + calcPaddedLen(pt.size))
        padded[0] = (pt.size ushr 8).toByte()
        padded[1] = pt.size.toByte()
        System.arraycopy(pt, 0, padded, 2, pt.size)
        val ciphertext = ChaCha20.xor(chachaKey, chachaNonce, padded)
        val mac = Bytes.hmacSha256(hmacKey, nonce + ciphertext)
        return Bytes.toBase64(byteArrayOf(2) + nonce + ciphertext + mac)
    }

    fun decrypt(payload: String, conversationKey: ByteArray): String {
        require(conversationKey.size == 32) { "conversation key must be 32 bytes" }
        if (payload.length > MAX_CIPHERTEXT_B64) {
            throw DecryptException("NIP-44 ciphertext is ${payload.length} base64 chars, over the $MAX_CIPHERTEXT_B64 ceiling")
        }
        if (payload.isEmpty() || payload[0] == '#') throw DecryptException("unknown encryption version")
        if (payload.length < MIN_CIPHERTEXT_B64) throw DecryptException("invalid payload length")
        val data = runCatching { Bytes.fromBase64(payload) }.getOrElse { throw DecryptException("invalid base64") }
        if (data.size < 99 || data.size > 65_603) throw DecryptException("invalid data length")
        if (data[0].toInt() != 2) throw DecryptException("unknown encryption version ${data[0]}")
        val nonce = data.copyOfRange(1, 33)
        val ciphertext = data.copyOfRange(33, data.size - 32)
        val mac = data.copyOfRange(data.size - 32, data.size)
        val keys = Bytes.hkdfExpand(conversationKey, nonce, 76)
        val expected = Bytes.hmacSha256(keys.copyOfRange(44, 76), nonce + ciphertext)
        if (!Bytes.equalsConstantTime(expected, mac)) throw DecryptException("invalid MAC")
        val padded = ChaCha20.xor(keys.copyOfRange(0, 32), keys.copyOfRange(32, 44), ciphertext)
        val len = ((padded[0].toInt() and 0xff) shl 8) or (padded[1].toInt() and 0xff)
        if (len < 1 || len > MAX_PLAINTEXT_BYTES || padded.size != 2 + calcPaddedLen(len)) {
            throw DecryptException("invalid padding")
        }
        return String(padded, 2, len, Charsets.UTF_8)
    }

    // ── The protocol's named entry points (crypto.ts) ───────────────────────

    fun eckEncrypt(eck: ByteArray, plaintext: String): String {
        require(eck.size == 32) { "ECK must be 32 bytes" }
        return encrypt(plaintext, eck)
    }

    fun eckDecrypt(eck: ByteArray, ciphertext: String): String {
        require(eck.size == 32) { "ECK must be 32 bytes" }
        return decrypt(ciphertext, eck)
    }

    fun encryptTo(senderSk: ByteArray, recipientPubkeyHex: String, plaintext: String): String =
        encrypt(plaintext, conversationKey(senderSk, recipientPubkeyHex))

    fun decryptFrom(recipientSk: ByteArray, senderPubkeyHex: String, ciphertext: String): String =
        decrypt(ciphertext, conversationKey(recipientSk, senderPubkeyHex))

    fun selfEncrypt(sk: ByteArray, plaintext: String): String = encrypt(plaintext, selfConversationKey(sk))

    fun selfDecrypt(sk: ByteArray, ciphertext: String): String = decrypt(ciphertext, selfConversationKey(sk))
}

/** RFC 8439 ChaCha20 (the raw stream cipher NIP-44 uses, without Poly1305). */
internal object ChaCha20 {
    private fun rotl(v: Int, c: Int) = (v shl c) or (v ushr (32 - c))

    private fun quarter(s: IntArray, a: Int, b: Int, c: Int, d: Int) {
        s[a] += s[b]; s[d] = rotl(s[d] xor s[a], 16)
        s[c] += s[d]; s[b] = rotl(s[b] xor s[c], 12)
        s[a] += s[b]; s[d] = rotl(s[d] xor s[a], 8)
        s[c] += s[d]; s[b] = rotl(s[b] xor s[c], 7)
    }

    private fun le32(b: ByteArray, o: Int) =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
            ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)

    fun xor(key: ByteArray, nonce: ByteArray, input: ByteArray, counter: Int = 0): ByteArray {
        require(key.size == 32 && nonce.size == 12)
        val state = IntArray(16)
        state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574
        for (i in 0 until 8) state[4 + i] = le32(key, i * 4)
        state[12] = counter
        for (i in 0 until 3) state[13 + i] = le32(nonce, i * 4)
        val out = ByteArray(input.size)
        val working = IntArray(16)
        val block = ByteArray(64)
        var offset = 0
        while (offset < input.size) {
            state.copyInto(working)
            repeat(10) {
                quarter(working, 0, 4, 8, 12); quarter(working, 1, 5, 9, 13)
                quarter(working, 2, 6, 10, 14); quarter(working, 3, 7, 11, 15)
                quarter(working, 0, 5, 10, 15); quarter(working, 1, 6, 11, 12)
                quarter(working, 2, 7, 8, 13); quarter(working, 3, 4, 9, 14)
            }
            for (i in 0 until 16) {
                val v = working[i] + state[i]
                block[i * 4] = v.toByte(); block[i * 4 + 1] = (v ushr 8).toByte()
                block[i * 4 + 2] = (v ushr 16).toByte(); block[i * 4 + 3] = (v ushr 24).toByte()
            }
            val n = minOf(64, input.size - offset)
            for (i in 0 until n) out[offset + i] = (input[offset + i].toInt() xor block[i].toInt()).toByte()
            offset += n
            state[12]++
        }
        return out
    }
}
