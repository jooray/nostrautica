package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.RosterContent

/**
 * "Also chat from White Noise" (NIP §10.5; chat/external-link.ts): the pure parts.
 * A 21607 `op:"link"` names the external key; for any key other than the account's
 * own, the coordinator answers with a one-time code inside a throwaway group that
 * the user reads in White Noise and sends back with `op:"link_confirm"`. Outcomes
 * arrive as 21606 notices on stage `chat_link`; success shows as an `external`
 * entry in the roster's `chat_keys`.
 */
object ExternalLink {
    const val STAGE = "chat_link"
    const val ATTESTATION_STAGE = "chat_attestation"
    const val LABEL = "White Noise"
    const val PENDING_TTL_MS = 30 * 60_000L

    /** npub, nprofile or 64-hex (optionally `nostr:`), never an nsec → lowercase hex. */
    fun parsePubkey(input: String): String? {
        val s = input.trim().removePrefix("nostr:").removePrefix("NOSTR:")
        if (Regex("^[0-9a-fA-F]{64}$").matches(s)) return s.lowercase()
        if (!Regex("^(npub|nprofile)1", RegexOption.IGNORE_CASE).containsMatchIn(s)) return null
        return Nip19.pubkeyFrom(s.lowercase())
    }

    fun isLinkedInRoster(roster: RosterContent?, account: String, chatPubkey: String): Boolean =
        roster?.attendees?.firstOrNull { it.pubkey == account }?.chatKeys.orEmpty().any { it.pubkey == chatPubkey }

    /**
     * The coordinator's latest word on a link started at [sinceSec]: the newest
     * `chat_link` notice no older than that (minus slack for a clock running ahead),
     * and strictly newer than [afterAt], the newest one already on hand when the
     * user acted, so an earlier refusal never greets a fresh attempt.
     */
    fun latestNotice(statuses: List<CoordinatorStatusContent>, sinceSec: Long, afterAt: Long = Long.MIN_VALUE, slackSec: Long = 120): CoordinatorStatusContent? =
        statuses.filter { it.stage == STAGE && it.at >= sinceSec - slackSec && it.at > afterAt }.maxByOrNull { it.at }

    fun newestNoticeAt(statuses: List<CoordinatorStatusContent>): Long =
        statuses.filter { it.stage == STAGE }.maxOfOrNull { it.at } ?: Long.MIN_VALUE

    private val REFUSALS = mapOf(
        "chat_link_unavailable" to "chat.wn.refused.unavailable",
        "chat_link_rate_limited" to "chat.wn.refused.rateLimited",
        "chat_link_no_key_package" to "chat.wn.refused.noKeyPackage",
        "chat_link_failed" to "chat.wn.refused.failed",
        "chat_link_no_pending" to "chat.wn.refused.noPending",
        "chat_link_expired" to "chat.wn.refused.expired",
        "chat_link_code_wrong" to "chat.wn.refused.codeWrong",
        "chat_link_too_many_attempts" to "chat.wn.refused.tooMany",
        "chat_device_cap_reached" to "chat.wn.refused.deviceCap",
        "chat_key_bound_to_other_account" to "chat.wn.refused.boundElsewhere",
        "chat_key_package_ineligible" to "chat.wn.refused.keyPackage",
    )

    /** String key for a refusal; an unknown category (a newer coordinator) gets a generic line. */
    fun refusalKey(category: String?): String = REFUSALS[category ?: ""] ?: "chat.wn.refused.other"

    /** A wrong code can be retyped; every other refusal ends the pending link. */
    fun refusalEndsLink(category: String?): Boolean = category != "chat_link_code_wrong"

    private val SETUP_REFUSALS = mapOf(
        "chat_device_cap_reached" to "chat.refused.deviceCap",
        "chat_key_bound_to_other_account" to "chat.refused.boundElsewhere",
        "chat_proof_invalid" to "chat.refused.proof",
        "chat_key_package_ineligible" to "chat.refused.keyPackage",
    )

    /** Why setup is stuck, from the newest poison `chat_attestation` notice. */
    fun setupRefusalKey(statuses: List<CoordinatorStatusContent>): String? {
        val n = statuses.filter { it.stage == ATTESTATION_STAGE && it.state == "poison" }.maxByOrNull { it.at } ?: return null
        return SETUP_REFUSALS[n.errorCategory ?: ""] ?: "chat.refused.other"
    }
}
