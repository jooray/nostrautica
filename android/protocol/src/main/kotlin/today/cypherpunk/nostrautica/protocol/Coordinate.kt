package today.cypherpunk.nostrautica.protocol

/** `<kind>:<E_id hex>:<d>` (coordinate.ts). */
data class Coordinate(val kind: Int, val pubkey: String, val identifier: String) {
    override fun toString(): String = "$kind:$pubkey:$identifier"

    val isCommunity: Boolean get() = kind == Kinds.COMMUNITY
    val isSpace: Boolean get() = kind in Kinds.SPACE_KINDS

    fun toNaddr(relays: List<String> = emptyList()): String =
        Nip19.naddr(Nip19.Addr(kind, pubkey, identifier, relays))

    companion object {
        fun make(pubkey: String, d: String, kind: Int = Kinds.CALENDAR_EVENT) = Coordinate(kind, pubkey, d)

        /** Generic parse: any kind. The identifier may itself contain colons. */
        fun parse(coordinate: String): Coordinate {
            val first = coordinate.indexOf(':')
            val second = coordinate.indexOf(':', first + 1)
            require(first >= 0 && second >= 0) { "invalid coordinate: $coordinate" }
            val kind = coordinate.substring(0, first).toIntOrNull()
            val pubkey = coordinate.substring(first + 1, second)
            require(kind != null && kind in 0..65535 && pubkey.isHex32()) { "invalid coordinate: $coordinate" }
            return Coordinate(kind, pubkey, coordinate.substring(second + 1))
        }

        fun parseOrNull(coordinate: String): Coordinate? = runCatching { parse(coordinate) }.getOrNull()

        /** A coordinate that must name a Nostrautica space (31923 event or 31612 community). */
        fun parseSpace(coordinate: String): Coordinate {
            val c = parse(coordinate)
            require(c.isSpace) { "not a Nostrautica event coordinate (kind ${c.kind}): $coordinate" }
            return c
        }

        fun isSpace(coordinate: String): Boolean = parseOrNull(coordinate)?.isSpace == true

        fun fromNaddr(naddr: String): Pair<Coordinate, List<String>> {
            val a = Nip19.decodeNaddr(naddr)
            return Coordinate(a.kind, a.pubkey, a.identifier) to a.relays
        }
    }
}
