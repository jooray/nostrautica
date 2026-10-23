package today.cypherpunk.nostrautica.domain.chat

/**
 * Edit and delete of your own chat messages (EventChat.svelte startEdit /
 * cancelEdit / saveEdit, session.svelte.ts editMessage). The wire format is
 * MDK's own: MarmotKit's `editMessage` publishes a kind 1009 with
 * `[["e", target], ...one ["p", hex] per mention]` (mentions re-derived from the
 * new text by `mention_p_tags`), and `deleteMessage` a kind 5 with `[["e", id]]`.
 * Receivers honour either only when it comes from the target's author, so this
 * app never offers them on anyone else's line.
 */
object MessageActions {
    /** Edit and Delete are offered on [m] only when it is this device's own, live line. */
    fun canModify(m: ChatMessage, me: String?): Boolean =
        me != null && m.sender == me && !m.deleted && !m.pending

    /**
     * The text to send as the edit, or null when there is nothing to send: an
     * empty draft (MDK refuses an empty edit; deleting is a separate action) or
     * one identical to what the message already says.
     */
    fun editedText(current: String, draft: String): String? {
        val text = draft.trim()
        return if (text.isEmpty() || text == current) null else text
    }

    /**
     * The composer while it holds one of your messages. [stash] is the draft that
     * was there before, restored on cancel or after the edit is saved. [message]
     * is the line as it was when editing began; the screen prefers the live copy.
     */
    data class Editing(val message: ChatMessage, val stash: String) {
        val id: String get() = message.id
    }

    /**
     * Start editing [m]. Switching from one edit straight to another keeps the
     * ORIGINAL draft as the stash, not the half-edited text of the first message.
     */
    fun start(current: Editing?, draft: String, m: ChatMessage): Editing =
        Editing(m, current?.stash ?: draft)

    /**
     * Whether an edit in progress has to be abandoned because its message is no
     * longer editable: deleted (from this or another of your devices) while the
     * composer held it. A message merely scrolled out of the loaded window stays.
     */
    fun stale(editing: Editing?, messages: List<ChatMessage>): Boolean =
        editing != null && messages.any { it.id == editing.id && it.deleted }
}
