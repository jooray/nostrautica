package today.cypherpunk.nostrautica.protocol

/**
 * Roster pagination (roster.ts, NIP §6.2.1). Page 0 lives at a base `d`, page N at
 * `<base>:N`; page 0's `pages` says how many there are. The base is [spaceRecordsD]
 * for a coordinator and the event's own `d` for E_id (or a legacy publish, §6.2.2).
 */
object Roster {
    const val PAGE_TARGET_BYTES = 60_000

    private const val SPACE_RECORDS_D_TAG = "nostrautica-space-records-v2"

    /**
     * The `d` a coordinator publishes a space's 31604 page 0 and 31606 at (audit R-53):
     * hex(sha256(JSON.stringify([tag, coordinate]))), so two same-named spaces on one
     * coordinator no longer share an address. Matches spaceRecordsD in roster.ts.
     */
    fun spaceRecordsD(coordinate: String): String {
        val sb = StringBuilder("[")
        JsJson.appendQuoted(sb, SPACE_RECORDS_D_TAG)
        sb.append(',')
        JsJson.appendQuoted(sb, coordinate)
        return Bytes.sha256Hex(Bytes.utf8(sb.append(']').toString()))
    }

    /** Both page-0 addresses a reader asks for, derived first, then the event `d`. */
    fun page0Ds(coordinate: String): List<String> =
        listOf(spaceRecordsD(coordinate), Coordinate.parse(coordinate).identifier).distinct()

    /** A 31604 at one of [ds] whose `a` tag, when present, names [coordinate] (isRosterPageFor). */
    fun isPageFor(coordinate: String, ds: List<String>, tags: List<List<String>>): Boolean {
        val d = tags.firstOrNull { it.size >= 2 && it[0] == "d" }?.get(1) ?: return false
        if (d !in ds) return false
        val a = tags.firstOrNull { it.size >= 2 && it[0] == "a" }?.get(1)
        return a == null || a == coordinate
    }

    fun pageD(base: String, page: Int): String {
        require(page >= 0) { "roster page index must be a non-negative integer, got $page" }
        return if (page == 0) base else "$base:$page"
    }

    /** Pages 1..pages-1 under [base] (page 0's own `d`), the count clamped to MAX_ROSTER_PAGES like roster.ts (audit R-54). */
    fun continuationDs(base: String, pages: Int): List<String> =
        (1 until pages.coerceIn(1, Limits.MAX_ROSTER_PAGES)).map { pageD(base, it) }

    fun pageCountOf(page0: RosterContent): Int = page0.pages ?: 1

    private fun bytes(r: RosterContent) = Bytes.utf8Length(Wire.json.encodeToString(RosterContent.serializer(), r))

    fun fitsOnePage(r: RosterContent) = bytes(r) <= Nip44.MAX_PLAINTEXT_BYTES

    private fun buildPage(r: RosterContent, index: Int, pages: Int, attendees: List<RosterAttendee>) =
        if (index > 0) RosterContent(v = Wire.ROSTER_PAGED_VERSION, eckCurrent = r.eckCurrent, attendees = attendees)
        else RosterContent(Wire.ROSTER_PAGED_VERSION, r.eckCurrent, r.nostrGroupId, pages, attendees)

    /** Split for publishing. A roster that fits is returned as-is (same object, still v:2). */
    fun split(r: RosterContent): List<RosterContent> {
        if (fitsOnePage(r)) return listOf(r)
        require(r.attendees.size <= Limits.MAX_ROSTER) { "roster has ${r.attendees.size} members, over the ${Limits.MAX_ROSTER}-member cap" }
        val groups = mutableListOf<List<RosterAttendee>>()
        var current = mutableListOf<RosterAttendee>()
        var overhead = bytes(buildPage(r, 0, Limits.MAX_ROSTER_PAGES, emptyList()))
        for (a in r.attendees) {
            val entry = Bytes.utf8Length(Wire.json.encodeToString(RosterAttendee.serializer(), a)) + 1
            if (current.isNotEmpty() && overhead + entry > PAGE_TARGET_BYTES) {
                groups += current
                current = mutableListOf()
                overhead = bytes(buildPage(r, groups.size, Limits.MAX_ROSTER_PAGES, emptyList()))
            }
            current += a
            overhead += entry
        }
        groups += current
        require(groups.size <= Limits.MAX_ROSTER_PAGES) { "roster needs ${groups.size} pages" }
        return groups.mapIndexed { i, att -> buildPage(r, i, groups.size, att) }
    }

    /** Reassemble pages (page 0 first) into one logical v:2 roster; duplicates keep their first occurrence. */
    fun merge(pages: List<RosterContent>): RosterContent {
        val page0 = pages.firstOrNull() ?: error("cannot merge an empty roster page set")
        val seen = HashSet<String>()
        // At most MAX_ROSTER members, in page order (mergeRosterPages, SB-28/SB-123).
        val attendees = pages.flatMap { it.attendees }.filter { seen.add(it.pubkey) }.take(Limits.MAX_ROSTER)
        return RosterContent(Wire.PROTOCOL_VERSION, page0.eckCurrent, page0.nostrGroupId, null, attendees)
    }
}
