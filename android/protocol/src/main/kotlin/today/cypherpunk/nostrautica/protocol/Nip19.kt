package today.cypherpunk.nostrautica.protocol

import java.io.ByteArrayOutputStream

/** Bech32 (BIP-173) and the NIP-19 entities the app reads and writes. */
object Bech32 {
    private const val CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    private val GEN = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)

    private fun polymod(values: IntArray): Int {
        var chk = 1
        for (v in values) {
            val b = chk ushr 25
            chk = ((chk and 0x1ffffff) shl 5) xor v
            for (i in 0 until 5) if ((b ushr i) and 1 == 1) chk = chk xor GEN[i]
        }
        return chk
    }

    private fun hrpExpand(hrp: String): IntArray =
        IntArray(hrp.length * 2 + 1).also { out ->
            hrp.forEachIndexed { i, c -> out[i] = c.code ushr 5; out[i + hrp.length + 1] = c.code and 31 }
        }

    fun convertBits(data: ByteArray, from: Int, to: Int, pad: Boolean): ByteArray {
        var acc = 0
        var bits = 0
        val out = ByteArrayOutputStream()
        val maxv = (1 shl to) - 1
        for (b in data) {
            val value = b.toInt() and 0xff
            require(value ushr from == 0) { "invalid data range" }
            acc = (acc shl from) or value
            bits += from
            while (bits >= to) {
                bits -= to
                out.write((acc ushr bits) and maxv)
            }
        }
        if (pad) {
            if (bits > 0) out.write((acc shl (to - bits)) and maxv)
        } else {
            require(bits < from && ((acc shl (to - bits)) and maxv) == 0) { "invalid padding" }
        }
        return out.toByteArray()
    }

    fun encode(hrp: String, data: ByteArray): String {
        val values = convertBits(data, 8, 5, true).map { it.toInt() }.toIntArray()
        val check = polymod(hrpExpand(hrp) + values + IntArray(6)) xor 1
        val sb = StringBuilder(hrp).append('1')
        for (v in values) sb.append(CHARSET[v])
        for (i in 0 until 6) sb.append(CHARSET[(check ushr (5 * (5 - i))) and 31])
        return sb.toString()
    }

    fun decode(input: String): Pair<String, ByteArray> {
        val s = input.trim()
        require(s == s.lowercase() || s == s.uppercase()) { "mixed case" }
        val lower = s.lowercase()
        val pos = lower.lastIndexOf('1')
        require(pos >= 1 && pos + 7 <= lower.length) { "invalid bech32" }
        val hrp = lower.substring(0, pos)
        val values = lower.substring(pos + 1).map { c ->
            CHARSET.indexOf(c).also { require(it >= 0) { "invalid bech32 character" } }
        }.toIntArray()
        require(polymod(hrpExpand(hrp) + values) == 1) { "invalid bech32 checksum" }
        val payload = values.copyOfRange(0, values.size - 6).map { it.toByte() }.toByteArray()
        return hrp to convertBits(payload, 5, 8, false)
    }
}

object Nip19 {
    data class Addr(val kind: Int, val pubkey: String, val identifier: String, val relays: List<String> = emptyList())
    data class Profile(val pubkey: String, val relays: List<String> = emptyList())

    fun npub(pubkeyHex: String): String = Bech32.encode("npub", Bytes.fromHex(pubkeyHex))
    fun nsec(sk: ByteArray): String = Bech32.encode("nsec", sk)

    fun decodeNpub(npub: String): String {
        val (hrp, data) = Bech32.decode(npub)
        require(hrp == "npub" && data.size == 32) { "not an npub" }
        return Bytes.toHex(data)
    }

    fun decodeNsec(nsec: String): ByteArray {
        val (hrp, data) = Bech32.decode(nsec)
        require(hrp == "nsec" && data.size == 32) { "not an nsec" }
        return data
    }

    fun naddr(a: Addr): String {
        val out = ByteArrayOutputStream()
        fun tlv(t: Int, v: ByteArray) { out.write(t); out.write(v.size); out.write(v) }
        // Same TLV order as nostr-tools (kind, author, relays, d), so links are byte-identical.
        tlv(3, byteArrayOf((a.kind ushr 24).toByte(), (a.kind ushr 16).toByte(), (a.kind ushr 8).toByte(), a.kind.toByte()))
        tlv(2, Bytes.fromHex(a.pubkey))
        a.relays.forEach { tlv(1, Bytes.utf8(it)) }
        tlv(0, Bytes.utf8(a.identifier))
        return Bech32.encode("naddr", out.toByteArray())
    }

    fun nprofile(p: Profile): String {
        val out = ByteArrayOutputStream()
        fun tlv(t: Int, v: ByteArray) { out.write(t); out.write(v.size); out.write(v) }
        p.relays.forEach { tlv(1, Bytes.utf8(it)) }
        tlv(0, Bytes.fromHex(p.pubkey))
        return Bech32.encode("nprofile", out.toByteArray())
    }

    private fun tlvs(data: ByteArray): Map<Int, List<ByteArray>> {
        val out = mutableMapOf<Int, MutableList<ByteArray>>()
        var i = 0
        while (i + 2 <= data.size) {
            val t = data[i].toInt() and 0xff
            val l = data[i + 1].toInt() and 0xff
            require(i + 2 + l <= data.size) { "truncated TLV" }
            out.getOrPut(t) { mutableListOf() }.add(data.copyOfRange(i + 2, i + 2 + l))
            i += 2 + l
        }
        return out
    }

    fun decodeNaddr(naddr: String): Addr {
        val (hrp, data) = Bech32.decode(naddr.removePrefix("nostr:"))
        require(hrp == "naddr") { "not an naddr" }
        val t = tlvs(data)
        val pk = t[2]?.firstOrNull()?.takeIf { it.size == 32 } ?: error("naddr missing author")
        val k = t[3]?.firstOrNull()?.takeIf { it.size == 4 } ?: error("naddr missing kind")
        val kind = ((k[0].toInt() and 0xff) shl 24) or ((k[1].toInt() and 0xff) shl 16) or
            ((k[2].toInt() and 0xff) shl 8) or (k[3].toInt() and 0xff)
        return Addr(
            kind = kind,
            pubkey = Bytes.toHex(pk),
            identifier = t[0]?.firstOrNull()?.toString(Charsets.UTF_8) ?: "",
            relays = t[1].orEmpty().map { it.toString(Charsets.UTF_8) },
        )
    }

    fun decodeNprofile(nprofile: String): Profile {
        val (hrp, data) = Bech32.decode(nprofile.removePrefix("nostr:"))
        require(hrp == "nprofile") { "not an nprofile" }
        val t = tlvs(data)
        val pk = t[0]?.firstOrNull()?.takeIf { it.size == 32 } ?: error("nprofile missing pubkey")
        return Profile(Bytes.toHex(pk), t[1].orEmpty().map { it.toString(Charsets.UTF_8) })
    }

    /**
     * A pubkey from whatever a person pastes: npub, nprofile, `nostr:` URI or hex.
     * Null when it is none of those.
     */
    fun pubkeyFrom(input: String): String? {
        val s = input.trim().removePrefix("nostr:")
        return runCatching {
            when {
                s.isHex32() -> s
                s.length == 64 && s.lowercase().isHex32() -> s.lowercase()
                s.startsWith("npub1") -> decodeNpub(s)
                s.startsWith("nprofile1") -> decodeNprofile(s).pubkey
                else -> null
            }
        }.getOrNull()
    }
}
