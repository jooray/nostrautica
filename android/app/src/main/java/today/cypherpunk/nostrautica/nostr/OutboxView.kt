package today.cypherpunk.nostrautica.nostr

import today.cypherpunk.nostrautica.data.db.OutboxRow
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent

/**
 * What the outbox indicator shows (stores/outbox.svelte.ts): the owner's unsent
 * rows split into waiting and failed, each with a human noun for its kind.
 */
object OutboxView {
    data class Item(val id: String, val kind: Int, val queuedAt: Long, val attempts: Int)
    data class State(val pending: List<Item>, val failed: List<Item>) {
        val isEmpty get() = pending.isEmpty() && failed.isEmpty()
    }

    val EMPTY = State(emptyList(), emptyList())

    /** [rows] are [Nostr.observeUnsent]'s (no partial rows); listed oldest first. */
    fun of(rows: List<OutboxRow>): State {
        val items = rows.sortedBy { it.queuedAt }.map { r ->
            r.failed to Item(r.id, NostrEvent.fromJsonString(r.json)?.kind ?: -1, r.queuedAt, r.attempts)
        }
        return State(items.filterNot { it.first }.map { it.second }, items.filter { it.first }.map { it.second })
    }

    /**
     * nostr/outbox-label.ts outboxKindKey (audit DS41-021). The outbox holds the outer
     * event, so most of what a member queues is a gift wrap whose real kind is sealed.
     */
    fun kindKey(kind: Int): String = when (kind) {
        Kinds.GIFT_WRAP -> "outbox.kind.message"
        Kinds.PROFILE, Kinds.MY_PROFILE -> "outbox.kind.profile"
        Kinds.CONTACTS -> "outbox.kind.follows"
        Kinds.DELETION -> "outbox.kind.deletion"
        Kinds.NOTE, Kinds.LONGFORM, Kinds.MEMBERS_POST -> "outbox.kind.post"
        Kinds.CALENDAR_RSVP -> "outbox.kind.rsvp"
        Kinds.RELAY_LIST, Kinds.DM_RELAY_LIST, Kinds.MUTE_LIST, Kinds.BLOSSOM_SERVERS, Kinds.APP_DATA -> "outbox.kind.settings"
        Kinds.CALENDAR_EVENT, Kinds.CALENDAR -> "outbox.kind.event"
        // Nostrautica's own replaceable records (config, invite list, roster, …: 31600-31612).
        in Kinds.EVENT_CONFIG..Kinds.COMMUNITY -> "outbox.kind.event"
        else -> "outbox.kind.other"
    }
}
