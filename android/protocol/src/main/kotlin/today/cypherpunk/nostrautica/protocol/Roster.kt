package today.cypherpunk.nostrautica.protocol

/**
 * Roster pagination (roster.ts, NIP §6.2.1). Page 0 lives at the event's own `d`,
 * page N at `<d>:N`; page 0's `pages` says how many there are.
 */
object Roster {
    const val PAGE_TARGET_BYTES = 60_000

    fun pageD(identifier: String, page: Int): String {
        require(page >= 0) { "roster page index must be a non-negative integer, got $page" }
        return if (page == 0) identifier else "$identifier:$page"
    }

    fun continuationDs(identifier: String, pages: Int): List<String> = (1 until maxOf(1, pages)).map { pageD(identifier, it) }

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
        val attendees = pages.flatMap { it.attendees }.filter { seen.add(it.pubkey) }
        return RosterContent(Wire.PROTOCOL_VERSION, page0.eckCurrent, page0.nostrGroupId, null, attendees)
    }
}
