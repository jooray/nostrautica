package today.cypherpunk.nostrautica.domain.chat

/**
 * IRC-style `/m` and `/msg` in the group-chat composer (chat/dm-command.ts).
 *
 * `/msg <name> <text>` sends a NIP-17 DM and opens that conversation; `/msg <name>`
 * alone just opens it. Display names contain spaces, so the recipient is not "the
 * next token": the remainder is matched against the known names, LONGEST first,
 * so "Juraj" cannot swallow a message addressed to "Juraj Bednár".
 */
object DmCommand {
    /** [account] is the person's ACCOUNT pubkey, never a chat device key. */
    data class Target(val account: String, val name: String)

    sealed interface Parsed {
        /** A recipient is settled; an empty [body] means "just open it". */
        data class Ready(val target: Target, val body: String) : Parsed
        /** Still choosing; [query] filters the picker. */
        data class Choosing(val query: String) : Parsed
    }

    private val CMD = Regex("^/(?:m|msg)(?:\\s+|$)", RegexOption.IGNORE_CASE)

    private fun startsWithFold(text: String, prefix: String) =
        text.length >= prefix.length && text.substring(0, prefix.length).lowercase() == prefix.lowercase()

    /** Null for anything that is not a command ("/msgpack is fine" included). */
    fun parse(draft: String, targets: List<Target>): Parsed? {
        val m = CMD.find(draft) ?: return null
        val rest = draft.substring(m.value.length)
        var best: Target? = null
        for (c in targets) {
            if (rest.length < c.name.length || !startsWithFold(rest, c.name)) continue
            val after = rest.substring(c.name.length)
            if (after.isNotEmpty() && !after[0].isWhitespace()) continue
            if (best == null || c.name.length > best.name.length) best = c
        }
        if (best != null) {
            val b = best
            val settled = rest.length > b.name.length ||
                targets.none { it.name.length > b.name.length && startsWithFold(it.name, rest) }
            if (settled) return Parsed.Ready(b, rest.substring(b.name.length).trim())
        }
        return Parsed.Choosing(rest.trimStart())
    }

    /** Prefix matches first, then names containing the query; empty lists everyone. */
    fun match(targets: List<Target>, query: String, limit: Int = 8): List<Target> {
        val q = query.lowercase()
        if (q.isEmpty()) return targets.take(limit)
        val pre = targets.filter { it.name.lowercase().startsWith(q) }
        val rest = targets.filter { val n = it.name.lowercase(); !n.startsWith(q) && n.contains(q) }
        return (pre + rest).take(limit)
    }
}
