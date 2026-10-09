package today.cypherpunk.nostrautica.protocol

import java.math.BigInteger
import java.text.Normalizer

/**
 * NIP-49 password-encrypted keys (`ncryptsec1…`): scrypt(NFKC password, salt,
 * 2^log_n, r=8, p=1) → XChaCha20-Poly1305 with the key-security byte as AAD.
 * The JDK has neither primitive, so both are here, small and tested against the
 * NIP's vector.
 */
object Nip49 {
    fun encrypt(sk: ByteArray, password: String, logN: Int = 16, keySecurity: Byte = 0x02): String {
        require(sk.size == 32)
        val salt = Bytes.random(16)
        val nonce = Bytes.random(24)
        val key = Scrypt.derive(Bytes.utf8(nfkc(password)), salt, 1 shl logN, 8, 1, 32)
        val ct = XChaCha20Poly1305.seal(key, nonce, sk, byteArrayOf(keySecurity))
        val payload = byteArrayOf(0x02, logN.toByte()) + salt + nonce + byteArrayOf(keySecurity) + ct
        return Bech32.encode("ncryptsec", payload)
    }

    fun decrypt(ncryptsec: String, password: String): ByteArray {
        val (hrp, data) = Bech32.decode(ncryptsec)
        require(hrp == "ncryptsec" && data.size == 91 && data[0].toInt() == 2) { "not an ncryptsec" }
        val logN = data[1].toInt() and 0xff
        require(logN in 1..22) { "unsupported scrypt cost" }
        val salt = data.copyOfRange(2, 18)
        val nonce = data.copyOfRange(18, 42)
        val ad = data.copyOfRange(42, 43)
        val ct = data.copyOfRange(43, 91)
        val key = Scrypt.derive(Bytes.utf8(nfkc(password)), salt, 1 shl logN, 8, 1, 32)
        return XChaCha20Poly1305.open(key, nonce, ct, ad) ?: throw IllegalArgumentException("wrong password")
    }

    private fun nfkc(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKC)
}

internal object Scrypt {
    fun derive(password: ByteArray, salt: ByteArray, n: Int, r: Int, p: Int, dkLen: Int): ByteArray {
        val b = pbkdf2(password, salt, p * 128 * r)
        val xy = IntArray(64 * r)
        val v = IntArray(32 * r * n)
        for (i in 0 until p) smix(b, i * 128 * r, r, n, v, xy)
        return pbkdf2(password, b, dkLen)
    }

    private fun pbkdf2(password: ByteArray, salt: ByteArray, len: Int): ByteArray {
        val out = ByteArray(len)
        var block = 1
        var off = 0
        while (off < len) {
            val u = Bytes.hmacSha256(password, salt + byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
            val n = minOf(32, len - off)
            System.arraycopy(u, 0, out, off, n)
            off += n; block++
        }
        return out
    }

    private fun smix(b: ByteArray, bi: Int, r: Int, n: Int, v: IntArray, xy: IntArray) {
        val x = IntArray(32 * r)
        for (k in 0 until 32 * r) {
            val o = bi + k * 4
            x[k] = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)
        }
        for (i in 0 until n) { System.arraycopy(x, 0, v, i * 32 * r, 32 * r); blockMix(x, r, xy) }
        for (i in 0 until n) {
            val j = x[(2 * r - 1) * 16] and (n - 1)
            for (k in 0 until 32 * r) x[k] = x[k] xor v[j * 32 * r + k]
            blockMix(x, r, xy)
        }
        for (k in 0 until 32 * r) {
            val o = bi + k * 4
            b[o] = x[k].toByte(); b[o + 1] = (x[k] ushr 8).toByte(); b[o + 2] = (x[k] ushr 16).toByte(); b[o + 3] = (x[k] ushr 24).toByte()
        }
    }

    private fun blockMix(b: IntArray, r: Int, y: IntArray) {
        val x = b.copyOfRange((2 * r - 1) * 16, 2 * r * 16)
        for (i in 0 until 2 * r) {
            for (k in 0 until 16) x[k] = x[k] xor b[i * 16 + k]
            salsa8(x)
            System.arraycopy(x, 0, y, i * 16, 16)
        }
        for (i in 0 until r) System.arraycopy(y, (2 * i) * 16, b, i * 16, 16)
        for (i in 0 until r) System.arraycopy(y, (2 * i + 1) * 16, b, (i + r) * 16, 16)
    }

    private fun rotl(a: Int, b: Int) = (a shl b) or (a ushr (32 - b))

    private fun salsa8(b: IntArray) {
        val x = b.copyOf()
        repeat(4) {
            x[4] = x[4] xor rotl(x[0] + x[12], 7); x[8] = x[8] xor rotl(x[4] + x[0], 9)
            x[12] = x[12] xor rotl(x[8] + x[4], 13); x[0] = x[0] xor rotl(x[12] + x[8], 18)
            x[9] = x[9] xor rotl(x[5] + x[1], 7); x[13] = x[13] xor rotl(x[9] + x[5], 9)
            x[1] = x[1] xor rotl(x[13] + x[9], 13); x[5] = x[5] xor rotl(x[1] + x[13], 18)
            x[14] = x[14] xor rotl(x[10] + x[6], 7); x[2] = x[2] xor rotl(x[14] + x[10], 9)
            x[6] = x[6] xor rotl(x[2] + x[14], 13); x[10] = x[10] xor rotl(x[6] + x[2], 18)
            x[3] = x[3] xor rotl(x[15] + x[11], 7); x[7] = x[7] xor rotl(x[3] + x[15], 9)
            x[11] = x[11] xor rotl(x[7] + x[3], 13); x[15] = x[15] xor rotl(x[11] + x[7], 18)
            x[1] = x[1] xor rotl(x[0] + x[3], 7); x[2] = x[2] xor rotl(x[1] + x[0], 9)
            x[3] = x[3] xor rotl(x[2] + x[1], 13); x[0] = x[0] xor rotl(x[3] + x[2], 18)
            x[6] = x[6] xor rotl(x[5] + x[4], 7); x[7] = x[7] xor rotl(x[6] + x[5], 9)
            x[4] = x[4] xor rotl(x[7] + x[6], 13); x[5] = x[5] xor rotl(x[4] + x[7], 18)
            x[11] = x[11] xor rotl(x[10] + x[9], 7); x[8] = x[8] xor rotl(x[11] + x[10], 9)
            x[9] = x[9] xor rotl(x[8] + x[11], 13); x[10] = x[10] xor rotl(x[9] + x[8], 18)
            x[12] = x[12] xor rotl(x[15] + x[14], 7); x[13] = x[13] xor rotl(x[12] + x[15], 9)
            x[14] = x[14] xor rotl(x[13] + x[12], 13); x[15] = x[15] xor rotl(x[14] + x[13], 18)
        }
        for (i in 0 until 16) b[i] += x[i]
    }
}

internal object XChaCha20Poly1305 {
    private fun le32(b: ByteArray, o: Int) =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)

    private fun rotl(v: Int, c: Int) = (v shl c) or (v ushr (32 - c))

    private fun hchacha20(key: ByteArray, nonce16: ByteArray): ByteArray {
        val s = IntArray(16)
        s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574
        for (i in 0 until 8) s[4 + i] = le32(key, i * 4)
        for (i in 0 until 4) s[12 + i] = le32(nonce16, i * 4)
        fun q(a: Int, b: Int, c: Int, d: Int) {
            s[a] += s[b]; s[d] = rotl(s[d] xor s[a], 16); s[c] += s[d]; s[b] = rotl(s[b] xor s[c], 12)
            s[a] += s[b]; s[d] = rotl(s[d] xor s[a], 8); s[c] += s[d]; s[b] = rotl(s[b] xor s[c], 7)
        }
        repeat(10) { q(0, 4, 8, 12); q(1, 5, 9, 13); q(2, 6, 10, 14); q(3, 7, 11, 15); q(0, 5, 10, 15); q(1, 6, 11, 12); q(2, 7, 8, 13); q(3, 4, 9, 14) }
        val out = ByteArray(32)
        for ((j, i) in listOf(0, 1, 2, 3, 12, 13, 14, 15).withIndex()) {
            out[j * 4] = s[i].toByte(); out[j * 4 + 1] = (s[i] ushr 8).toByte(); out[j * 4 + 2] = (s[i] ushr 16).toByte(); out[j * 4 + 3] = (s[i] ushr 24).toByte()
        }
        return out
    }

    private fun subKeyAndNonce(key: ByteArray, nonce24: ByteArray): Pair<ByteArray, ByteArray> =
        hchacha20(key, nonce24.copyOfRange(0, 16)) to (ByteArray(4) + nonce24.copyOfRange(16, 24))

    private fun pad16(n: Int) = ByteArray((16 - n % 16) % 16)

    private fun le64(n: Long) = ByteArray(8) { (n ushr (8 * it)).toByte() }

    private fun tag(key: ByteArray, nonce: ByteArray, aad: ByteArray, ct: ByteArray): ByteArray {
        val polyKey = ChaCha20.xor(key, nonce, ByteArray(32), 0)
        return poly1305(polyKey, aad + pad16(aad.size) + ct + pad16(ct.size) + le64(aad.size.toLong()) + le64(ct.size.toLong()))
    }

    fun seal(key: ByteArray, nonce24: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val (k, n) = subKeyAndNonce(key, nonce24)
        val ct = ChaCha20.xor(k, n, plaintext, 1)
        return ct + tag(k, n, aad, ct)
    }

    fun open(key: ByteArray, nonce24: ByteArray, sealed: ByteArray, aad: ByteArray): ByteArray? {
        if (sealed.size < 16) return null
        val (k, n) = subKeyAndNonce(key, nonce24)
        val ct = sealed.copyOfRange(0, sealed.size - 16)
        if (!Bytes.equalsConstantTime(tag(k, n, aad, ct), sealed.copyOfRange(sealed.size - 16, sealed.size))) return null
        return ChaCha20.xor(k, n, ct, 1)
    }

    private val P = BigInteger.ONE.shiftLeft(130).subtract(BigInteger.valueOf(5))

    private fun leBig(b: ByteArray): BigInteger = BigInteger(1, b.reversedArray())

    private fun poly1305(key: ByteArray, msg: ByteArray): ByteArray {
        val rBytes = key.copyOfRange(0, 16)
        rBytes[3] = (rBytes[3].toInt() and 15).toByte(); rBytes[7] = (rBytes[7].toInt() and 15).toByte()
        rBytes[11] = (rBytes[11].toInt() and 15).toByte(); rBytes[15] = (rBytes[15].toInt() and 15).toByte()
        rBytes[4] = (rBytes[4].toInt() and 252).toByte(); rBytes[8] = (rBytes[8].toInt() and 252).toByte(); rBytes[12] = (rBytes[12].toInt() and 252).toByte()
        val r = leBig(rBytes)
        val s = leBig(key.copyOfRange(16, 32))
        var acc = BigInteger.ZERO
        var i = 0
        while (i < msg.size) {
            val chunk = msg.copyOfRange(i, minOf(i + 16, msg.size)) + byteArrayOf(1)
            acc = acc.add(leBig(chunk)).multiply(r).mod(P)
            i += 16
        }
        val t = acc.add(s).toByteArray().reversedArray()
        return ByteArray(16) { if (it < t.size) t[it] else 0 }
    }
}
