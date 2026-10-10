package today.cypherpunk.nostrautica.domain.content

import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM decryption that streams (spec §6.2 media: whole-file, 12-byte IV,
 * 16-byte tag appended).
 *
 * The platform's GCM buffers the whole ciphertext AND the whole plaintext until
 * the tag checks out, which for a 250 MB talk is half a gigabyte of heap on a
 * phone. GCM is CTR mode plus a GHASH over the ciphertext, so this decrypts
 * with AES-CTR and computes GHASH alongside, in constant memory. The plaintext
 * goes to a file that is only ever handed to a player AFTER the tag (and the
 * plaintext hash, `ox`) verified; on a mismatch the caller deletes it.
 *
 * GHASH uses the 4-bit table method (Shoup), as in mbed TLS's gcm.c.
 */
class StreamingGcm(key: ByteArray, private val nonce: ByteArray) {
    private val ctr: Cipher
    private val hh = LongArray(16)
    private val hl = LongArray(16)
    private val ej0: ByteArray
    private var zh = 0L
    private var zl = 0L
    private val pending = ByteArray(16)
    private var pendingLen = 0
    private var cLen = 0L

    init {
        require(key.size == 32) { "AES-GCM key must be 32 bytes" }
        require(nonce.size == 12) { "AES-GCM nonce must be 12 bytes" }
        val ecb = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")) }
        val h = ecb.doFinal(ByteArray(16))
        ej0 = ecb.doFinal(counterBlock(1))
        ctr = Cipher.getInstance("AES/CTR/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(counterBlock(2)))
        }
        var vh = beLong(h, 0)
        var vl = beLong(h, 8)
        hl[8] = vl; hh[8] = vh
        var i = 4
        while (i > 0) {
            val t = if (vl and 1L != 0L) 0xe1000000L else 0L
            vl = (vh shl 63) or (vl ushr 1)
            vh = (vh ushr 1) xor (t shl 32)
            hl[i] = vl; hh[i] = vh
            i = i shr 1
        }
        i = 2
        while (i <= 8) {
            val bh = hh[i]; val bl = hl[i]
            for (j in 1 until i) { hh[i + j] = bh xor hh[j]; hl[i + j] = bl xor hl[j] }
            i *= 2
        }
    }

    private fun counterBlock(n: Int) = nonce + byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())

    private fun beLong(b: ByteArray, off: Int): Long {
        var v = 0L
        for (k in 0 until 8) v = (v shl 8) or (b[off + k].toLong() and 0xff)
        return v
    }

    /** Z = (Z xor block) · H. */
    private fun ghashBlock(b: ByteArray, off: Int) {
        val xh = zh xor beLong(b, off)
        val xl = zl xor beLong(b, off + 8)
        fun byteAt(i: Int): Int = ((if (i < 8) xh ushr (56 - 8 * i) else xl ushr (56 - 8 * (i - 8))) and 0xff).toInt()
        var lo = byteAt(15) and 0xf
        var h = hh[lo]
        var l = hl[lo]
        for (i in 15 downTo 0) {
            val xi = byteAt(i)
            lo = xi and 0xf
            val hi = (xi ushr 4) and 0xf
            if (i != 15) {
                val rem = (l and 0xf).toInt()
                l = (h shl 60) or (l ushr 4)
                h = (h ushr 4) xor (LAST4[rem] shl 48)
                h = h xor hh[lo]; l = l xor hl[lo]
            }
            val rem = (l and 0xf).toInt()
            l = (h shl 60) or (l ushr 4)
            h = (h ushr 4) xor (LAST4[rem] shl 48)
            h = h xor hh[hi]; l = l xor hl[hi]
        }
        zh = h; zl = l
    }

    private fun ghash(data: ByteArray, off: Int, len: Int) {
        var p = off
        val end = off + len
        if (pendingLen > 0) {
            val take = minOf(16 - pendingLen, len)
            System.arraycopy(data, p, pending, pendingLen, take)
            pendingLen += take; p += take
            if (pendingLen == 16) { ghashBlock(pending, 0); pendingLen = 0 }
        }
        while (end - p >= 16) { ghashBlock(data, p); p += 16 }
        if (p < end) { System.arraycopy(data, p, pending, 0, end - p); pendingLen = end - p }
    }

    /** Decrypt a chunk of ciphertext (without the tag). */
    fun update(c: ByteArray, off: Int, len: Int): ByteArray {
        ghash(c, off, len)
        cLen += len
        return ctr.update(c, off, len) ?: ByteArray(0)
    }

    /** True when [tag] authenticates everything passed to [update]. */
    fun verify(tag: ByteArray): Boolean {
        if (pendingLen > 0) {
            java.util.Arrays.fill(pending, pendingLen, 16, 0)
            ghashBlock(pending, 0)
            pendingLen = 0
        }
        val lens = ByteArray(16)
        val bits = cLen * 8
        for (k in 0 until 8) lens[8 + k] = (bits ushr (56 - 8 * k)).toByte()
        ghashBlock(lens, 0)
        val s = ByteArray(16)
        for (k in 0 until 8) { s[k] = (zh ushr (56 - 8 * k)).toByte(); s[8 + k] = (zl ushr (56 - 8 * k)).toByte() }
        val expected = ByteArray(16) { (s[it].toInt() xor ej0[it].toInt()).toByte() }
        return tag.size == 16 && MessageDigest.isEqual(expected, tag)
    }

    companion object {
        private val LAST4 = longArrayOf(
            0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0,
            0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0,
        )

        class Result(val ok: Boolean, val reason: String? = null)

        /**
         * Decrypt [ciphertextLen] bytes of `ciphertext || tag` from [input] into
         * [output], checking the tag and then sha256(plaintext) == [oxHex].
         * [onChunk] is called between chunks (cancellation checks).
         */
        fun decrypt(
            input: InputStream, ciphertextLen: Long, key: ByteArray, nonce: ByteArray, oxHex: String,
            output: OutputStream, onChunk: () -> Unit = {},
        ): Result {
            if (ciphertextLen < 16) return Result(false, "ciphertext shorter than the GCM tag")
            val gcm = StreamingGcm(key, nonce)
            val sha = MessageDigest.getInstance("SHA-256")
            var remaining = ciphertextLen - 16
            val buf = ByteArray(64 * 1024)
            while (remaining > 0) {
                onChunk()
                val n = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                if (n < 0) return Result(false, "ciphertext ended early")
                val p = gcm.update(buf, 0, n)
                sha.update(p); output.write(p)
                remaining -= n
            }
            val tag = ByteArray(16)
            var got = 0
            while (got < 16) { val n = input.read(tag, got, 16 - got); if (n < 0) return Result(false, "ciphertext ended early"); got += n }
            val tail = gcm.ctr.doFinal()
            if (tail != null && tail.isNotEmpty()) { sha.update(tail); output.write(tail) }
            if (!gcm.verify(tag)) return Result(false, "authentication tag mismatch")
            val ox = today.cypherpunk.nostrautica.protocol.Bytes.toHex(sha.digest())
            if (ox != oxHex.lowercase()) return Result(false, "plaintext sha256 mismatch (ox)")
            return Result(true)
        }
    }
}
