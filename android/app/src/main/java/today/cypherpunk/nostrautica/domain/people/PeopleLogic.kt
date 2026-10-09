package today.cypherpunk.nostrautica.domain.people

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import today.cypherpunk.nostrautica.domain.ProfileMeta
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.Match
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// Pure rules of the People area, ported one for one from the PWA so they can be
// unit-tested without a device. Each block names the TS module it mirrors.

// ── confidence.ts ────────────────────────────────────────────────────────────

/** A match's plain-language band. "Strong" is a PER-ATTENDEE cut (see [Confidence]). */
enum class Band { STRONG, GOOD, HELLO }

/**
 * Match confidence bands (events/confidence.ts). "Strong" means "one of your top
 * [STRONG_RANK] AND at least [STRONG_FLOOR]": the rank half adapts to an attendee
 * whose scores run hot or cold, the floor keeps it honest for someone whose best
 * pair is 0.60. Below strong the threshold is absolute.
 */
object Confidence {
    const val STRONG_FLOOR = 0.75
    const val STRONG_RANK = 3
    const val GOOD_THRESHOLD = 0.6

    /** Non-finite scores (a misbehaving coordinator) sort last and band as "hello". */
    private fun finite(v: Double?): Double = if (v != null && v.isFinite()) v else Double.NEGATIVE_INFINITY

    /** The score at or above which a match is "strong" for this attendee. */
    fun strongCutFor(matches: List<Match>): Double = strongCutForScores(matches.map { it.score })

    fun strongCutForScores(scores: List<Double>): Double {
        if (scores.isEmpty()) return STRONG_FLOOR
        val sorted = scores.map(::finite).sortedDescending()
        val nth = sorted[minOf(STRONG_RANK, sorted.size) - 1]
        return maxOf(STRONG_FLOOR, nth)
    }

    fun bandAtCut(score: Double, strongCut: Double): Band {
        val s = finite(score)
        return when {
            s >= strongCut -> Band.STRONG
            s >= GOOD_THRESHOLD -> Band.GOOD
            else -> Band.HELLO
        }
    }

    /** Score, then complementarity, then similarity — all descending. */
    val byMatchRank: Comparator<Match> = Comparator { a, b ->
        compareValues(finite(b.score), finite(a.score)).takeIf { it != 0 }
            ?: compareValues(finite(b.complementarity), finite(a.complementarity)).takeIf { it != 0 }
            ?: compareValues(finite(b.similarity), finite(a.similarity))
    }
}

/** The bands that get full entries at the top of People (Attendees.svelte `featured`). */
data class FeaturedSection(val band: Band, val items: List<Match>)

object Featured {
    /**
     * Strong and good normally; "worth a hello" only for the attendee who has
     * nothing better (12% of real users), so the page always says something.
     */
    fun sections(visible: List<Match>, bandOf: (Match) -> Band): List<FeaturedSection> {
        val strong = visible.filter { bandOf(it) == Band.STRONG }
        val good = visible.filter { bandOf(it) == Band.GOOD }
        if (strong.isNotEmpty() || good.isNotEmpty()) {
            return listOf(FeaturedSection(Band.STRONG, strong), FeaturedSection(Band.GOOD, good)).filter { it.items.isNotEmpty() }
        }
        val hello = visible.filter { bandOf(it) == Band.HELLO }
        return if (hello.isNotEmpty()) listOf(FeaturedSection(Band.HELLO, hello)) else emptyList()
    }

    /** Nothing sharp at the top: say so rather than let the heading imply it. */
    fun noStrong(matchingOn: Boolean, visible: List<Match>, bandOf: (Match) -> Band): Boolean =
        matchingOn && visible.isNotEmpty() && visible.none { bandOf(it) == Band.STRONG }
}

// ── roster.ts / search.ts ────────────────────────────────────────────────────

object Search {
    private val MARKS = Regex("[\\u0300-\\u036f]")
    private val WS = Regex("\\s+")

    fun normalize(s: String): String = MARKS.replace(Normalizer.normalize(s, Normalizer.Form.NFD), "").lowercase()

    /** Every whitespace-separated token of [query] appears in [haystack], diacritic-folded. */
    fun matchesQuery(haystack: String, query: String): Boolean {
        val q = normalize(query).trim()
        if (q.isEmpty()) return true
        val hay = normalize(haystack)
        return q.split(WS).all { hay.contains(it) }
    }

    data class Fields(val name: String, val rest: List<String>)

    /** The searchable halves of one directory entry (search.ts directoryEntryFields). */
    fun fields(entry: DirectoryEntryContent, displayName: String, locale: String?): Fields {
        val rest = mutableListOf<String>()
        fun add(v: String?) { if (!v.isNullOrEmpty()) rest += v }
        fun addAll(v: List<String>?) { v?.filter { it.isNotEmpty() }?.let { rest += it } }
        if (!entry.name.isNullOrEmpty() && entry.name != displayName) add(entry.name)
        add(entry.profile.about)
        addAll(entry.profile.skills)
        add(entry.profile.lookingFor)
        add(entry.introText)
        entry.aiProfile?.let { ai ->
            add(ai.summary); addAll(ai.skills); addAll(ai.interests); addAll(ai.offers); addAll(ai.seeks)
            val tr = ai.translations
            if (tr != null && (locale == null || tr.lang == locale)) { add(tr.about); addAll(tr.skills); add(tr.lookingFor) }
        }
        entry.transcripts?.forEach { add(it.text) }
        return Fields(displayName, rest)
    }

    /** Name hits first, then body-only hits; incoming order otherwise kept. Blank query = unchanged. */
    fun <T> rank(items: List<T>, query: String, fieldsOf: (T) -> Fields): List<T> {
        if (query.isBlank()) return items
        val nameHits = mutableListOf<T>()
        val bodyHits = mutableListOf<T>()
        for (item in items) {
            val f = fieldsOf(item)
            if (matchesQuery(f.name, query)) nameHits += item
            else if (matchesQuery((listOf(f.name) + f.rest).joinToString(" "), query)) bodyHits += item
        }
        return nameHits + bodyHits
    }
}

// ── Names and bios (Attendees.svelte nameOf/bioOf, Attendee.svelte) ──────────

object PeopleNames {
    private fun String?.nz(): String? = this?.takeIf { it.isNotEmpty() }

    /** kind-0 name, the directory-entry name, a slice of the bio, then a pubkey stub. */
    fun nameOf(pubkey: String, profile: ProfileMeta?, entry: DirectoryEntryContent?, about: String? = null): String =
        profile?.name.nz() ?: entry?.name.nz() ?: about?.take(40).nz() ?: (pubkey.take(10) + "…")

    /** The translation of the authored fields, when the viewer reads its language. */
    fun translation(entry: DirectoryEntryContent, locale: String) =
        entry.aiProfile?.translations?.takeIf { it.lang == locale }

    /** What they wrote for this event, else their live Nostr bio. */
    fun bioOf(entry: DirectoryEntryContent?, profile: ProfileMeta?, locale: String): String? =
        (entry?.let { translation(it, locale)?.about.nz() ?: it.profile.about.nz() }) ?: profile?.about.nz()

    /** attendeeDisplayName: live kind-0 (display_name first), entry name, bio slice, fallback. */
    fun attendeeDisplayName(kind0: JsonObject?, entry: DirectoryEntryContent?, fallback: String): String =
        kind0?.let(ProfileMeta::displayName) ?: entry?.name.nz() ?: entry?.profile?.about?.take(40).nz() ?: fallback

    /** Their current Nostr bio, only when it differs from the text already shown. */
    fun nostrAbout(liveAbout: String?, aboutText: String): String {
        val live = liveAbout?.trim().orEmpty()
        if (live.isEmpty()) return ""
        return if (live == aboutText.trim()) "" else live
    }
}

// ── The People list's states (Attendees.svelte module script) ───────────────

enum class EmptyReason { LOADING, NOT_APPROVED, STALE_KEY, UNREACHABLE, NONE }

object RosterState {
    fun emptyReason(loading: Boolean, hasKey: Boolean, undecryptable: Int, online: Boolean, relayConnected: Boolean): EmptyReason = when {
        loading -> EmptyReason.LOADING
        !hasKey -> EmptyReason.NOT_APPROVED
        undecryptable > 0 -> EmptyReason.STALE_KEY
        !online || !relayConnected -> EmptyReason.UNREACHABLE
        else -> EmptyReason.NONE
    }

    data class StaleCue(val show: Boolean, val at: Long? = null)

    /** Say how old a cache-painted list is, once settled and unconfirmed. */
    fun staleCue(entries: Int, settled: Boolean, confirmed: Boolean, syncedAt: Long?): StaleCue =
        if (entries == 0 || confirmed || !settled) StaleCue(false) else StaleCue(true, syncedAt)

    /** "as of 14:05" today; anything older carries its date. */
    fun formatAsOf(atMs: Long, nowMs: Long, locale: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val l = Locale.forLanguageTag(locale)
        val d = Instant.ofEpochMilli(atMs).atZone(zone)
        val n = Instant.ofEpochMilli(nowMs).atZone(zone)
        val f = if (d.toLocalDate() == n.toLocalDate()) DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
        else DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        return f.withLocale(l).format(d)
    }
}

/** The directory rows below the featured matches (Attendees.svelte `visible`). */
object Directory {
    fun rows(
        byName: List<DirectoryEntryContent>,
        query: String,
        hasFilters: Boolean,
        passes: (String) -> Boolean,
        featured: Set<String>,
        newPubkeys: Set<String>,
        fieldsOf: (DirectoryEntryContent) -> Search.Fields,
    ): List<DirectoryEntryContent> {
        val rows = Search.rank(byName.filter { passes(it.pubkey) && (hasFilters || it.pubkey !in featured) }, query, fieldsOf)
        if (hasFilters || newPubkeys.isEmpty()) return rows
        return rows.filter { it.pubkey in newPubkeys } + rows.filter { it.pubkey !in newPubkeys }
    }
}

// ── whats-new.ts ─────────────────────────────────────────────────────────────

/**
 * What the user had already seen in an event (owner-scoped, local). `seenPeople`
 * null means "no baseline yet": nobody is new on a first visit. Field names are
 * the PWA's, so the record reads the same on both apps.
 */
@Serializable
data class Watermark(
    val seenMatches: List<String> = emptyList(),
    val seenPeople: List<String>? = null,
    val seenApproved: Boolean = false,
    val at: Long = 0,
)

object WhatsNewRules {
    fun newMatchPubkeys(matches: List<String>?, seen: List<String>): List<String> {
        if (matches == null) return emptyList()
        val s = seen.toSet()
        return matches.filter { it !in s }
    }

    fun newPeoplePubkeys(entries: List<String>?, seen: List<String>?): List<String> {
        if (entries == null || seen == null) return emptyList()
        val s = seen.toSet()
        return entries.filter { it !in s }
    }

    /** New matches and new arrivals as ONE deduped set: the badge and the row markers agree. */
    fun newSince(matches: List<String>?, entries: List<String>?, wm: Watermark): List<String> =
        (newMatchPubkeys(matches, wm.seenMatches) + newPeoplePubkeys(entries, wm.seenPeople)).distinct()

    fun approvalIsNew(approved: Boolean, wm: Watermark): Boolean = approved && !wm.seenApproved
}

// ── report.ts ────────────────────────────────────────────────────────────────

data class ReportPerson(val pubkey: String, val npub: String, val name: String, val note: String? = null)
data class ReportTalk(val d: String, val title: String)
data class EventReport(
    val met: List<ReportPerson>,
    val wantedNotMet: List<ReportPerson>,
    val favoriteTalks: List<ReportTalk>,
    val notes: List<ReportPerson>,
) {
    val isEmpty get() = met.isEmpty() && wantedNotMet.isEmpty() && favoriteTalks.isEmpty() && notes.isEmpty()

    /** met ∪ wanted, deduped: who "follow all" and the npub export act on. */
    val allPeople: List<ReportPerson> get() = (met + wantedNotMet).distinctBy { it.pubkey }
}

object Report {
    fun safeNpub(pubkey: String): String = runCatching { Nip19.npub(pubkey) }.getOrDefault(pubkey)

    private fun person(pubkey: String, nameOf: (String) -> String, note: String?) =
        ReportPerson(pubkey, safeNpub(pubkey), nameOf(pubkey), note?.trim()?.takeIf { it.isNotEmpty() })

    fun assemble(settings: PerEventSettings, favoriteTalks: List<ReportTalk>, nameOf: (String) -> String): EventReport {
        val notes = settings.notes
        val metSet = settings.met.toSet()
        return EventReport(
            met = settings.met.map { person(it, nameOf, notes[it]) },
            wantedNotMet = settings.wantToMeet.filter { it !in metSet }.map { person(it, nameOf, notes[it]) },
            favoriteTalks = favoriteTalks,
            notes = notes.keys.filter { !notes[it].isNullOrBlank() }.map { person(it, nameOf, notes[it]) },
        )
    }

    /** met first, then the remaining want-to-meet, minus opt-outs. */
    fun followTargets(settings: PerEventSettings, optOut: Set<String> = emptySet()): List<String> =
        (settings.met + settings.wantToMeet).distinct().filter { it !in optOut }

    fun npubList(people: List<ReportPerson>): String =
        people.joinToString("\n") { p -> "${p.npub}  ${p.name}" + (p.note?.let { "  ($it)" } ?: "") }
}

// ── settings.ts (list toggles) ───────────────────────────────────────────────

enum class SettingList(val wire: String) { FAVORITES("favorites"), WANT_TO_MEET("want_to_meet"), MET("met") }

object SettingsRules {
    private fun toggle(list: List<String>, pk: String) = if (pk in list) list.filter { it != pk } else list + pk

    fun toggled(s: PerEventSettings, list: SettingList, pubkey: String): PerEventSettings = when (list) {
        SettingList.FAVORITES -> s.copy(favorites = toggle(s.favorites, pubkey))
        SettingList.WANT_TO_MEET -> s.copy(wantToMeet = toggle(s.wantToMeet, pubkey))
        SettingList.MET -> s.copy(met = toggle(s.met, pubkey))
    }

    fun withNote(s: PerEventSettings, pubkey: String, note: String): PerEventSettings {
        val n = LinkedHashMap(s.notes)
        if (note.trim().isNotEmpty()) n[pubkey] = note.trim() else n.remove(pubkey)
        return s.copy(notes = n)
    }

    fun has(s: PerEventSettings?, list: SettingList, pubkey: String): Boolean = when (list) {
        SettingList.FAVORITES -> s?.favorites
        SettingList.WANT_TO_MEET -> s?.wantToMeet
        SettingList.MET -> s?.met
    }?.contains(pubkey) == true
}

// ── readiness.ts (the one input People needs) ────────────────────────────────

object IntroRules {
    /** An intro is a recording (media kind "intro") or a text intro. */
    fun hasIntro(entry: DirectoryEntryContent): Boolean =
        entry.media.any { it.kind == "intro" } || !entry.introText.isNullOrBlank()
}
