package today.cypherpunk.nostrautica.domain.content

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.EventPage
import today.cypherpunk.nostrautica.protocol.EventPageContent
import today.cypherpunk.nostrautica.protocol.EventPagePrivate
import today.cypherpunk.nostrautica.protocol.ExternalFeed
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.PageSection
import today.cypherpunk.nostrautica.protocol.Wire

@Serializable
data class PageMenuItem(val label: String, val target: String, val membersOnly: Boolean = false)

@Serializable
data class PageSectionItem(val section: PageSection, val membersOnly: Boolean = false)

/**
 * The organizer's event page (events/event-page.ts EventPageModel): the 31608's
 * public menu/sections with the ECK-encrypted members-only parts merged in by
 * `pos`, plus the curated external feeds. [newer] is set when the page was
 * written by a newer protocol than this build reads: the UI says "update" and
 * renders the default layout.
 */
@Serializable
data class EventPageModel(
    val menu: List<PageMenuItem> = emptyList(),
    val sections: List<PageSectionItem> = emptyList(),
    val sources: List<ExternalFeed> = emptyList(),
    val newer: Boolean = false,
)

/** Where a menu/pin target leads (event-page.ts ResolvedTarget). */
sealed interface ResolvedTarget {
    data class Url(val href: String) : ResolvedTarget
    data class Post(val d: String) : ResolvedTarget
    data class Naddr(val naddr: String) : ResolvedTarget
}

object PageLogic {
    /**
     * Assemble the page from the newest 31608 BY E_id (a relay answering with
     * someone else's page would repoint the menu and inject feeds). Null when no
     * page exists or it is malformed: callers fall back to the default layout.
     */
    fun assemble(eid: String, events: List<NostrEvent>, eck: List<EckVersion>): EventPageModel? {
        val latest = Ordering.pickLatest(events.filter { it.kind == Kinds.EVENT_PAGE && it.pubkey == eid }) ?: return null
        val content = when (val r = Wire.parseSafe(EventPageContent.serializer(), latest.content)) {
            is Wire.Result.Ok -> r.value
            is Wire.Result.Newer -> return EventPageModel(newer = true)
            is Wire.Result.Invalid -> return null
        }
        val publicMenu = EventPage.rTagsToMenu(latest.tags)
        var priv = EventPagePrivate()
        if (content.private != null) {
            val versionId = latest.tag("eck")?.toIntOrNull()
            val version = eck.firstOrNull { it.id == versionId }
            if (version != null) {
                runCatching { EventPage.decryptPrivate(version.bytes(), content.private!!) }.onSuccess { priv = it }
            }
        }
        return EventPageModel(
            menu = EventPage.mergeMenu(publicMenu, priv.menu).map { PageMenuItem(it.item.label, it.item.target, it.membersOnly) },
            sections = EventPage.mergeSections(content.sections, priv.sections).map { PageSectionItem(it.item, it.membersOnly) },
            sources = content.sources,
        )
    }

    /** Classify a menu/pin target: https URL, one of this event's posts (internal), or a foreign naddr. */
    fun resolveTarget(eid: String, target: String): ResolvedTarget? {
        if (target.startsWith("https://")) return ResolvedTarget.Url(target)
        if (!target.startsWith("nostr:")) return null
        val bech = target.removePrefix("nostr:")
        val a = runCatching { Nip19.decodeNaddr(bech) }.getOrNull() ?: return null
        if (a.pubkey == eid && (a.kind == Kinds.LONGFORM || a.kind == Kinds.MEMBERS_POST)) return ResolvedTarget.Post(a.identifier)
        return ResolvedTarget.Naddr(bech)
    }

    /** A pinned ref (an naddr, with or without `nostr:`) → this event's post `d`; foreign refs are skipped. */
    fun pinnedD(eid: String, ref: String): String? {
        val a = runCatching { Nip19.decodeNaddr(ref.removePrefix("nostr:")) }.getOrNull() ?: return null
        return if (a.pubkey == eid) a.identifier else null
    }

    /** The newest official post: the "Latest" highlight on the Overview. */
    fun latest(official: List<EventPost>): EventPost? = official.maxByOrNull { it.publishedAt }

    /**
     * Posts for a `posts` section by its source × visibility, minus anything
     * already featured (the Latest highlight, a pinned card).
     */
    fun sectionPosts(section: PageSection.Posts, official: List<EventPost>, attendees: List<EventPost>, featured: Set<String>): List<EventPost> =
        PostLogic.filter(official, attendees, PostLogic.sourceOf(section.source), PostLogic.visibilityOf(section.visibility))
            .filter { it.key !in featured }

    /** Does any section need the attendee feed? */
    fun needsAttendeePosts(model: EventPageModel?): Boolean =
        model?.sections?.any { (it.section as? PageSection.Posts)?.source?.let { s -> s != "event" } == true } == true
}
