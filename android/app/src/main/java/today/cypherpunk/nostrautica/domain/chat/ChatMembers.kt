package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.protocol.RosterContent

/**
 * Roster-driven account/device mapping for chat (NIP §10.1; chat/members.ts).
 *
 * Every member the group shows is a per-DEVICE key; one person may hold several.
 * The ECK roster's `chat_keys` binds those device keys to one account per
 * attendee, so a message from either of someone's devices is attributed to the
 * same person, and the member list shows one row per person.
 */
object ChatMembers {
    data class Device(val pubkey: String, val label: String?, val addedAt: Long, val external: Boolean = false)

    data class Member(val account: String, val organizer: Boolean, val devices: List<Device>) {
        val deviceCount get() = devices.size
    }

    /** What a list is derived from: real MLS membership, or roster attestations only. */
    enum class Source { GROUP, ATTESTED }

    data class MemberList(val members: List<Member>, val source: Source)

    /** Every attested device key → its account (and each account → itself). */
    fun deviceAccountMap(roster: RosterContent?): Map<String, String> {
        val out = HashMap<String, String>()
        for (a in roster?.attendees.orEmpty()) {
            out[a.pubkey] = a.pubkey
            a.chatKeys?.forEach { out[it.pubkey] = a.pubkey }
        }
        return out
    }

    fun accountOf(device: String, map: Map<String, String>): String = map[device] ?: device

    /**
     * One entry per person. [groupDevices] — device keys holding a leaf in this
     * event's group — is authoritative when known; it filters the roster and keeps
     * members the roster has not caught up with yet. Null means "unknown" and falls
     * back to the roster (who ATTESTED), which the UI labels as such. [exclude]
     * drops the coordinator's own admin leaf, which is disclosed, not a person.
     */
    fun list(roster: RosterContent?, groupDevices: Collection<String>?, exclude: Collection<String> = emptyList()): MemberList {
        val excluded = exclude.toSet()
        val present = groupDevices?.filterNot { it in excluded }?.toSet()
        val accounted = HashSet<String>()
        val members = ArrayList<Member>()
        for (a in roster?.attendees.orEmpty()) {
            val keys = a.chatKeys.orEmpty()
            val shown = if (present != null) keys.filter { it.pubkey in present } else keys
            shown.forEach { accounted += it.pubkey }
            if (shown.isEmpty()) continue
            members += Member(a.pubkey, a.role == "organizer", shown.map { Device(it.pubkey, it.label, it.addedAt, it.external == true) })
        }
        for (pk in present.orEmpty()) {
            if (pk in accounted) continue
            members += Member(pk, false, listOf(Device(pk, null, 0)))
        }
        members.sortWith(compareBy<Member>({ !it.organizer }, { it.account }))
        return MemberList(members, if (present != null) Source.GROUP else Source.ATTESTED)
    }

    /** The attested devices of one account, for the "Chat devices" card. */
    fun devicesFor(roster: RosterContent?, account: String): List<Device> =
        roster?.attendees?.firstOrNull { it.pubkey == account }?.chatKeys.orEmpty()
            .map { Device(it.pubkey, it.label, it.addedAt, it.external == true) }

    /** Every pubkey the chat UI resolves a profile for (warm.ts chatProfilePubkeys). */
    fun profilePubkeys(roster: RosterContent?): Pair<List<String>, List<String>> {
        val accounts = LinkedHashSet<String>()
        val devices = LinkedHashSet<String>()
        for (a in roster?.attendees.orEmpty()) {
            accounts += a.pubkey
            a.chatKeys?.forEach { devices += it.pubkey }
        }
        return accounts.toList() to devices.toList()
    }

    /**
     * `added_at` is unix seconds; rosters from before that was fixed carry
     * milliseconds. A value that large can only be ms.
     */
    fun addedAtMillis(addedAt: Long): Long = if (addedAt > 1_000_000_000_000L) addedAt else addedAt * 1000

    /** Our device kind-0 reads "<name>"; older ones "Nostrautica <name> (chat)". Strip that for display. */
    fun cleanName(raw: String): String =
        raw.trim().replace(Regex("^Nostrautica\\s+", RegexOption.IGNORE_CASE), "").replace(Regex("\\s*\\(chat\\)\\s*$", RegexOption.IGNORE_CASE), "")
}
