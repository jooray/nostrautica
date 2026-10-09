package today.cypherpunk.nostrautica.protocol

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Byte helpers shared by every module: hex, base64, SHA-256, HMAC, HKDF, randomness. */
object Bytes {
    private val random = SecureRandom()
    private val HEX = "0123456789abcdef".toCharArray()

    fun random(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    fun toHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xff
            out[i * 2] = HEX[v ushr 4]
            out[i * 2 + 1] = HEX[v and 0x0f]
        }
        return String(out)
    }

    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd-length hex" }
        return ByteArray(hex.length / 2) { i ->
            val hi = Character.digit(hex[i * 2], 16)
            val lo = Character.digit(hex[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "invalid hex" }
            ((hi shl 4) or lo).toByte()
        }
    }

    /** Standard base64 with padding, as browsers' `btoa` produces. */
    fun toBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun fromBase64(b64: String): ByteArray = Base64.getDecoder().decode(b64)

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun sha256Hex(bytes: ByteArray): String = toHex(sha256(bytes))

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    fun hkdfExtract(salt: ByteArray, ikm: ByteArray): ByteArray = hmacSha256(salt, ikm)

    fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val n = minOf(previous.size, length - offset)
            System.arraycopy(previous, 0, out, offset, n)
            offset += n
            counter++
        }
        return out
    }

    /** Constant-time comparison, for MACs. */
    fun equalsConstantTime(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun utf8Length(s: String): Int = utf8(s).size
}

private val HEX64 = Regex("^[0-9a-f]{64}$")
private val HEX128 = Regex("^[0-9a-f]{128}$")

/** Canonical lowercase 32-byte hex (pubkeys, event ids). */
fun String.isHex32(): Boolean = HEX64.matches(this)

/** Canonical lowercase 64-byte hex (Schnorr signatures). */
fun String.isHex64(): Boolean = HEX128.matches(this)
