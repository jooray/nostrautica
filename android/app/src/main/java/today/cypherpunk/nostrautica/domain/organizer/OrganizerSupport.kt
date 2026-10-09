package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.CoordinatorAnnounce
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Nip19
import java.net.URI
import java.net.URLEncoder

/** creation-outcomes.ts: each publication of a create reports its own state. */
object CreationReceipt {
    enum class State { OK, FAILED, SKIPPED, PENDING }

    data class Receipt(val event: State, val enrolled: State, val grant: State, val backup: State) {
        val allSettled get() = listOf(event, enrolled, grant, backup).none { it == State.FAILED }
    }

    fun build(enrollAttempted: Boolean, enrollFailed: Boolean, coordinatorPicked: Boolean, attachFailed: Boolean, freshLocalKey: Boolean, backupConfirmed: Boolean) =
        Receipt(
            event = State.OK,
            enrolled = if (!enrollAttempted) State.SKIPPED else if (enrollFailed) State.FAILED else State.OK,
            grant = if (!coordinatorPicked) State.SKIPPED else if (attachFailed) State.FAILED else State.OK,
            backup = if (!freshLocalKey || backupConfirmed) State.OK else State.PENDING,
        )
}

/** duplicate.ts: a config-only prefill; never keys, coordinate, d, coordinator or dates. */
data class DuplicatePrefill(
    val title: String,
    val summary: String,
    val iconUrl: String,
    val bannerUrl: String,
    val talks: String,
    val matching: Boolean,
    val matchVisibility: String,
    val approval: String,
    val lang: String,
    val maxVideoSec: Int,
    val maxTalkSec: Int,
    val chatEnabled: Boolean,
) {
    companion object {
        fun from(title: String, summary: String, icon: String?, banner: String?, config: EventConfig, copyOf: (String) -> String) = DuplicatePrefill(
            title = copyOf(title), summary = summary, iconUrl = icon ?: "", bannerUrl = banner ?: "",
            talks = config.talks, matching = config.matching, matchVisibility = config.matchVisibility,
            approval = config.approval, lang = config.lang, maxVideoSec = config.maxVideoSec, maxTalkSec = config.maxTalkSec,
            chatEnabled = config.chat.isNotEmpty(),
        )
    }
}

/** stores/duplicate-draft.ts: handed from "Duplicate event" to the create form, taken once. */
object DuplicateDraft {
    @Volatile private var pending: DuplicatePrefill? = null
    fun set(p: DuplicatePrefill) { pending = p }
    fun take(): DuplicatePrefill? = pending.also { pending = null }
}

/** A discovered kind-31611 coordinator (coordinators.ts DiscoveredCoordinator). */
@Serializable
data class DiscoveredCoordinator(val pubkey: String, val npub: String, val announce: CoordinatorAnnounce, val createdAt: Long)

object CoordinatorHelpers {
    /** npub or hex → lowercase hex, else null. */
    fun parseKey(input: String): String? {
        var pk = input.trim()
        if (pk.isEmpty()) return null
        if (pk.startsWith("npub1")) pk = runCatching { Nip19.decodeNpub(pk) }.getOrNull() ?: return null
        return if (Regex("^[0-9a-fA-F]{64}$").matches(pk)) pk.lowercase() else null
    }

    /** coordinators.ts pricingLabel (English in the PWA too). */
    fun pricingLabel(a: CoordinatorAnnounce): String {
        val p = a.pricing
        if (p == null || p.model == "free") return "Free"
        p.summary?.let { return it }
        p.freeUpToUsers?.let { return "Free up to $it, then paid" }
        if (p.model == "negotiated") return "Pricing by quote"
        return "Paid"
    }

    /** https: only (audits APPR-1/APPR-2). */
    fun httpsUrl(url: String?): String? = url?.let { runCatching { URI(it) }.getOrNull() }?.takeIf { it.scheme == "https" && !it.host.isNullOrEmpty() }?.toString()

    /** Append `event=<naddr>` to a billing checkout URL; null for anything not https. */
    fun checkoutUrlForEvent(checkoutUrl: String, naddr: String): String? {
        val safe = httpsUrl(checkoutUrl) ?: return null
        val u = URI(safe)
        val params = (u.rawQuery?.split('&')?.filter { it.isNotEmpty() && !it.startsWith("event=") } ?: emptyList()) +
            ("event=" + URLEncoder.encode(naddr, "UTF-8"))
        return URI(u.scheme, u.rawAuthority, u.rawPath, null, null).toString() + "?" + params.joinToString("&") +
            (u.rawFragment?.let { "#$it" } ?: "")
    }

    /** create/Settings image URL field: https, no credentials. */
    fun externalImageUrl(raw: String): String? = runCatching { URI(raw.trim()) }.getOrNull()
        ?.takeIf { it.scheme == "https" && !it.host.isNullOrEmpty() && it.rawUserInfo == null }?.toString()
}
