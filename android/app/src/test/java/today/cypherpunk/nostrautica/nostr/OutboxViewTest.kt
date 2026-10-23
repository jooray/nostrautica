package today.cypherpunk.nostrautica.nostr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.data.db.OutboxRow
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent

/** The outbox indicator's split and labels (stores/outbox.svelte.ts, nostr/outbox-label.ts). */
class OutboxViewTest {
    private fun row(id: String, kind: Int, queuedAt: Long, failed: Boolean = false, attempts: Int = 0, json: String? = null) = OutboxRow(
        id = id, owner = "me",
        json = json ?: NostrEvent(id, "p".repeat(64), 1, kind, emptyList(), "", "s".repeat(128)).toJsonString(),
        relays = "[]", missing = "[]", attempts = attempts, lastAttemptAt = 0, queuedAt = queuedAt,
        failed = failed, partial = false, label = null,
    )

    @Test fun splitsWaitingFromFailedOldestFirst() {
        val st = OutboxView.of(listOf(
            row("b", Kinds.GIFT_WRAP, 20),
            row("c", Kinds.CONTACTS, 5, failed = true, attempts = 5),
            row("a", Kinds.PROFILE, 10),
        ))
        assertEquals(listOf("a", "b"), st.pending.map { it.id })
        assertEquals(listOf("c"), st.failed.map { it.id })
        assertEquals(Kinds.CONTACTS, st.failed[0].kind)
        assertEquals(5, st.failed[0].attempts)
        assertTrue(OutboxView.of(emptyList()).isEmpty)
    }

    @Test fun unreadableJsonIsStillListedSoItCanBeDiscarded() {
        val st = OutboxView.of(listOf(row("x", 0, 1, json = "{not json")))
        assertEquals(-1, st.pending.single().kind)
        assertEquals("outbox.kind.other", OutboxView.kindKey(-1))
    }

    @Test fun kindLabelsMatchTheWeb() {
        assertEquals("outbox.kind.message", OutboxView.kindKey(Kinds.GIFT_WRAP))
        assertEquals("outbox.kind.profile", OutboxView.kindKey(Kinds.MY_PROFILE))
        assertEquals("outbox.kind.post", OutboxView.kindKey(Kinds.MEMBERS_POST))
        assertEquals("outbox.kind.rsvp", OutboxView.kindKey(Kinds.CALENDAR_RSVP))
        assertEquals("outbox.kind.settings", OutboxView.kindKey(Kinds.DM_RELAY_LIST))
        assertEquals("outbox.kind.event", OutboxView.kindKey(Kinds.ROSTER))
        assertEquals("outbox.kind.event", OutboxView.kindKey(Kinds.COMMUNITY))
        assertEquals("outbox.kind.other", OutboxView.kindKey(Kinds.MLS_GROUP_MESSAGE))
    }
}
