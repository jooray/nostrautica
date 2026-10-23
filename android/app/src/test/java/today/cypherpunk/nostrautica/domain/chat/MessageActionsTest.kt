package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.Nip19

class MessageActionsTest {
    private val me = "a".repeat(64)
    private val other = "b".repeat(64)
    private fun msg(id: String, sender: String = me, text: String = "hi", deleted: Boolean = false, pending: Boolean = false) =
        ChatMessage(id, sender, text, 1_760_000_000L, deleted = deleted, pending = pending)

    @Test fun onlyYourOwnLiveMessageCanBeEditedOrDeleted() {
        assertTrue(MessageActions.canModify(msg("1"), me))
        // Receivers drop an edit or delete from anyone but the author, so it is never offered.
        assertFalse(MessageActions.canModify(msg("1", sender = other), me))
        assertFalse(MessageActions.canModify(msg("1", deleted = true), me))
        assertFalse(MessageActions.canModify(msg("1", pending = true), me))
        // No chat device key yet: nothing is ours.
        assertFalse(MessageActions.canModify(msg("1"), null))
    }

    @Test fun anEmptyOrUnchangedEditSendsNothing() {
        assertNull(MessageActions.editedText("hi", "   "))
        assertNull(MessageActions.editedText("hi", " hi \n"))
        assertEquals("hello", MessageActions.editedText("hi", "  hello\n"))
    }

    @Test fun anEditKeepsTheLiteralMentionMdkDerivesThePTagFrom() {
        val npub = "npub1fngg32tel6hy5rnq2dmsevmtezu0th5ql23s9a2p3ake3pdx73yslx5jqt"
        val text = MessageActions.editedText("hi", "hi @$npub ")!!
        assertEquals("hi @$npub", text)
        assertEquals(listOf(listOf("p", Nip19.decodeNpub(npub))), Mentions.pTags(text))
    }

    @Test fun switchingEditsKeepsTheOriginalDraftAsTheStash() {
        val first = MessageActions.start(null, "my draft", msg("1", text = "one"))
        assertEquals("1", first.id)
        assertEquals("my draft", first.stash)
        // The composer now holds "one (half edited)"; editing another line must not stash that.
        val second = MessageActions.start(first, "one (half edited)", msg("2", text = "two"))
        assertEquals("2", second.id)
        assertEquals("my draft", second.stash)
    }

    @Test fun anEditIsAbandonedOnlyWhenItsMessageIsDeleted() {
        val e = MessageActions.start(null, "", msg("1"))
        assertFalse(MessageActions.stale(null, listOf(msg("1", deleted = true))))
        assertFalse(MessageActions.stale(e, listOf(msg("1"))))
        // Scrolled out of the loaded window: still editable.
        assertFalse(MessageActions.stale(e, listOf(msg("2"))))
        assertTrue(MessageActions.stale(e, listOf(msg("1", deleted = true))))
    }
}
