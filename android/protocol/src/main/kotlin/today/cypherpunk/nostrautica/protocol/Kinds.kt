package today.cypherpunk.nostrautica.protocol

/** Event kinds (packages/protocol/src/kinds.ts). */
object Kinds {
    const val PROFILE = 0
    const val NOTE = 1
    const val CONTACTS = 3
    const val DELETION = 5
    const val REPOST = 6
    const val SEAL = 13
    const val DM = 14
    const val LONGFORM = 30023
    const val RELAY_LIST = 10002
    const val DM_RELAY_LIST = 10050
    const val MUTE_LIST = 10000
    const val BLOSSOM_SERVERS = 10063
    const val GIFT_WRAP = 1059
    const val APP_DATA = 30078
    const val BLOSSOM_AUTH = 24242
    const val NIP46 = 24133

    const val CALENDAR_EVENT = 31923
    const val CALENDAR_RSVP = 31925

    const val EVENT_CONFIG = 31600
    const val INVITE_LIST = 31601
    const val MY_PROFILE = 31602
    const val DIRECTORY_ENTRY = 31603
    const val ROSTER = 31604
    const val MATCH_LIST = 31605
    const val MATCH_MATRIX = 31606
    const val MEMBERS_POST = 31607
    const val EVENT_PAGE = 31608
    const val EVENT_THEME = 31609
    const val TALK = 31610
    const val COORDINATOR_ANNOUNCE = 31611
    const val COMMUNITY = 31612
    const val COORDINATOR_ANNOUNCE_D = "nostrautica:coordinator"

    const val JOIN_REQUEST = 21600
    const val PROFILE_SUBMISSION = 21601
    const val KEY_GRANT = 21602
    const val COORDINATOR_GRANT = 21603
    const val ADMIN_COMMAND = 21604
    const val ORGANIZER_GRANT = 21605
    const val COORDINATOR_STATUS = 21606
    const val CHAT_KEY_ATTESTATION = 21607
    const val PROFILE_CORRECTION = 21608
    const val TALK_SUBMISSION = 21609
    const val ATTENDEE_WITHDRAWAL = 21610

    // Marmot (MLS over Nostr)
    const val MLS_KEY_PACKAGE = 30443
    const val MLS_GROUP_MESSAGE = 445

    val RUMOR_KINDS: Set<Int> = setOf(
        DM, JOIN_REQUEST, PROFILE_SUBMISSION, KEY_GRANT, COORDINATOR_GRANT, ADMIN_COMMAND,
        ORGANIZER_GRANT, COORDINATOR_STATUS, CHAT_KEY_ATTESTATION, PROFILE_CORRECTION,
        TALK_SUBMISSION, ATTENDEE_WITHDRAWAL,
    )

    /** Attendee → E_inbox (§6.1). */
    val EVENT_INBOX_RUMOR_KINDS: Set<Int> =
        setOf(JOIN_REQUEST, PROFILE_SUBMISSION, PROFILE_CORRECTION, TALK_SUBMISSION, ATTENDEE_WITHDRAWAL)

    /** → an organizer identity (E_id or a co-organizer's account key). */
    val ORGANIZER_RUMOR_KINDS: Set<Int> = setOf(ORGANIZER_GRANT, COORDINATOR_STATUS)

    /** → an attendee's own account key. */
    val ATTENDEE_RUMOR_KINDS: Set<Int> = setOf(DM, KEY_GRANT, ORGANIZER_GRANT, COORDINATOR_STATUS)

    val SPACE_KINDS: Set<Int> = setOf(CALENDAR_EVENT, COMMUNITY)

    fun isAddressable(kind: Int) = kind in 30000..39999
    fun isReplaceable(kind: Int) = kind == 0 || kind == 3 || kind in 10000..19999
}
