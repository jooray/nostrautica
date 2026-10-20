package today.cypherpunk.nostrautica.protocol

/**
 * ECK version identity across organizer devices (PROTOCOL-NIP.md §4.1, audit
 * SB-86). Port of packages/protocol/src/eck-identity.ts.
 *
 * Two devices rotating at once both mint `max+1` with different keys, so a
 * version is `(id, key)`: unions keep both keys of a same-id pair, the current
 * version is the highest id then the lowest fingerprint, and records name their
 * key with `["eck", "<id>", "<fp>"]`.
 */
object EckIdentity {
    private val DOMAIN = "nostrautica:eck-fp:".toByteArray(Charsets.UTF_8)
    private val FP = Regex("^[0-9a-f]{16}$")

    fun fingerprint(key: ByteArray): String = Bytes.toHex(Bytes.sha256(DOMAIN + key)).substring(0, 16)

    fun fingerprint(keyB64: String): String {
        val bytes = runCatching { Bytes.fromBase64(keyB64) }.getOrElse { "!$keyB64".toByteArray(Charsets.UTF_8) }
        return fingerprint(bytes)
    }

    private val order = compareBy<EckVersion> { it.id }.thenBy { fingerprint(it.key) }

    /** Union by `(id, key)`, sorted by id then fingerprint. */
    fun union(vararg lists: List<EckVersion>): List<EckVersion> {
        val seen = LinkedHashMap<String, EckVersion>()
        for (l in lists) for (v in l) seen.putIfAbsent("${v.id}|${v.key}", EckVersion(v.id, v.key))
        return seen.values.sortedWith(order)
    }

    /** Highest id, ties to the lowest fingerprint. */
    fun canonical(versions: List<EckVersion>): EckVersion? = versions.sortedWith(order).let { s ->
        val maxId = s.lastOrNull()?.id ?: return null
        s.first { it.id == maxId }
    }

    fun collisionIds(versions: List<EckVersion>): List<Int> =
        versions.groupBy { it.id }.filter { (_, vs) -> vs.map { it.key }.toSet().size > 1 }.keys.sorted()

    fun tag(v: EckVersion): List<String> = listOf("eck", v.id.toString(), fingerprint(v.key))

    fun tag(id: Int, key: ByteArray): List<String> = listOf("eck", id.toString(), fingerprint(key))

    data class Ref(val id: Int, val fp: String? = null)

    fun readTag(tags: List<List<String>>): Ref? {
        val t = tags.firstOrNull { it.isNotEmpty() && it[0] == "eck" } ?: return null
        val id = t.getOrNull(1)?.let(Wire::jsInteger)?.takeIf { it > 0 } ?: return null
        val fp = t.getOrNull(2)?.lowercase()
        return if (fp != null && FP.matches(fp)) Ref(id, fp) else Ref(id)
    }

    /** Held keys that may decrypt a record tagged [ref], best first; empty = not held. */
    fun candidates(versions: List<EckVersion>, ref: Ref): List<EckVersion> {
        val sameId = versions.filter { it.id == ref.id }.sortedWith(order)
        return if (ref.fp != null) sameId.filter { fingerprint(it.key) == ref.fp } else sameId
    }
}
