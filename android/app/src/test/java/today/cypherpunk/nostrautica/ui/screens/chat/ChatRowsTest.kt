package today.cypherpunk.nostrautica.ui.screens.chat

import org.junit.Assert.assertEquals
import org.junit.Test
import today.cypherpunk.nostrautica.domain.chat.ChatMessage

/**
 * The chat LazyColumn crash-looped on a real phone after the MDK 0.16 upgrade:
 * `Key "day:13. 11. 2026" was already used`. MDK's timeline order is not strictly
 * by time, so a day came round twice and repeated its separator key.
 */
class ChatRowsTest {
    private val day1 = 1_794_000_000L // 2026-11-12 (UTC)
    private val day2 = day1 + 86_400

    private fun msg(id: String, at: Long, sender: String = "a") = ChatMessage(id = id, sender = sender, text = id, at = at)

    @Test
    fun `out-of-order timeline gives unique keys and one separator per day`() {
        val rows = chatRows(listOf(msg("1", day1), msg("2", day2), msg("3", day1 + 60), msg("4", day2 + 60)), "sk")
        val keys = rows.map { it.key }
        assertEquals(keys.size, keys.toSet().size)
        assertEquals(2, rows.count { it is ChatRow.Day })
        assertEquals(listOf("1", "3", "2", "4"), rows.filterIsInstance<ChatRow.Msg>().map { it.m.id })
    }

    @Test
    fun `a repeated message id is shown once`() {
        val rows = chatRows(listOf(msg("1", day1), msg("1", day1)), "sk")
        assertEquals(1, rows.count { it is ChatRow.Msg })
        assertEquals(rows.size, rows.map { it.key }.toSet().size)
    }

    @Test
    fun `in-order messages keep one separator per day and sender grouping`() {
        val rows = chatRows(listOf(msg("1", day1, "a"), msg("2", day1 + 5, "a"), msg("3", day2, "b")), "sk")
        assertEquals(listOf(true, false, true), rows.filterIsInstance<ChatRow.Msg>().map { it.showSender })
        assertEquals(2, rows.count { it is ChatRow.Day })
    }
}
