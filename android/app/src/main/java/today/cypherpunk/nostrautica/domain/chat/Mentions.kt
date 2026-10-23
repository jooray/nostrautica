package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.protocol.Nip19

/**
 * People mentioned inside a group-chat message, encoded the way White Noise
 * encodes them so the two clients agree on who was tagged (chat/mentions.ts).
 *
 *  - Content: the composer inserts the literal `@npub1…` followed by a space
 *    (whitenoise-android MentionComposer.kt `insertMention`). There is no hidden
 *    span; the chip is a visual treatment of that literal run.
 *  - Tags: MDK's inner-event builder (marmot-app messages/intents.rs
 *    `mention_p_tags`) appends one `["p", <hex>]` per DISTINCT mentioned pubkey,
 *    first-seen order. MarmotKit's `sendText` goes through that builder, so this
 *    app sends the text alone; [pTags] exists to pin our parser to MDK's.
 *  - Recognized on receipt: `@npub1…`, a bare `npub1…`, and `nostr:npub`/
 *    `nostr:nprofile` URIs, each with a word boundary on both sides: the
 *    neighbour may not be an ASCII letter, digit, `_` or `/`, which keeps
 *    `foo@npub1…` and a URL path from turning into mentions.
 *
 * Pure: names and avatars are the screen's business, keyed by the pubkey here.
 */
object Mentions {
    sealed interface Segment {
        data class Text(val value: String) : Segment
        /** [pubkey] is hex; [raw] is the exact source text. */
        data class Mention(val pubkey: String, val raw: String) : Segment
    }

    // One alternation, longest form first. `@?` in front of `nostr:` swallows the
    // "@" sometimes typed before a URI, so it is not left beside the chip.
    private const val BECH32 = "[02-9ac-hj-np-z]"
    private val MENTION = Regex("@?nostr:((?:npub|nprofile)1$BECH32{6,})|@(npub1$BECH32{6,})|(npub1$BECH32{6,})")
    private val CHIP_AT = Regex("@npub1$BECH32+")
    private val CHIP_BEFORE_CARET = Regex("(?:^|(?<=\\s))@npub1$BECH32{58}( ?)$")

    /** MDK's `left_boundary_ok` / `right_boundary_ok`: not [A-Za-z0-9_/]. */
    private fun isBoundary(ch: Char?): Boolean =
        ch == null || !(ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '_' || ch == '/')

    /** The hex pubkey a bech32 npub/nprofile names, or null for anything else. */
    fun pubkeyOfBech32(bech32: String): String? = runCatching {
        when {
            bech32.startsWith("npub1") -> Nip19.decodeNpub(bech32)
            bech32.startsWith("nprofile1") -> Nip19.decodeNprofile(bech32).pubkey
            else -> null
        }
    }.getOrNull()

    /** Split message text into plain runs and person mentions. */
    fun parse(content: String): List<Segment> {
        val out = ArrayList<Segment>()
        var last = 0
        var from = 0
        while (from <= content.length) {
            val m = MENTION.find(content, from) ?: break
            val start = m.range.first
            val end = m.range.last + 1
            val bare = m.groups[3] != null
            val bech32 = (m.groups[1] ?: m.groups[2] ?: m.groups[3])!!.value
            // A bare `npub1…` right after "@" or "nostr:" is the tail of a longer
            // form that already failed (bad checksum); MDK leaves it literal.
            val prev = content.getOrNull(start - 1)
            val leftOk = isBoundary(prev) &&
                !(bare && (prev == '@' || (start >= 6 && content.regionMatches(start - 6, "nostr:", 0, 6))))
            val pubkey = if (leftOk && isBoundary(content.getOrNull(end))) pubkeyOfBech32(bech32) else null
            if (pubkey == null) {
                from = start + 1
                continue
            }
            if (start > last) out += Segment.Text(content.substring(last, start))
            out += Segment.Mention(pubkey, m.value)
            last = end
            from = end
        }
        if (last < content.length) out += Segment.Text(content.substring(last))
        return out
    }

    /** Distinct mentioned pubkeys, in first-seen order. */
    fun mentionedPubkeys(content: String): List<String> =
        parse(content).filterIsInstance<Segment.Mention>().map { it.pubkey }.distinct()

    /** The `p` tags MDK derives for this content: one per distinct person, first-seen order. */
    fun pTags(content: String): List<List<String>> = mentionedPubkeys(content).map { listOf("p", it) }

    /** `npub1abcd…wxyz`: enough to tell two people with one display name apart. */
    fun shortNpub(pubkey: String): String = runCatching {
        val npub = Nip19.npub(pubkey)
        "${npub.take(9)}…${npub.takeLast(4)}"
    }.getOrDefault(pubkey.take(8))

    // ── composing ───────────────────────────────────────────────────────────

    /** An open `@` query in the composer: the `@` at [start], then [query] up to the caret. */
    data class Active(val start: Int, val query: String)

    /**
     * The `@`-query the caret is in, or null. White Noise's `activeMentionQuery`
     * rules: the nearest `@` left of the caret with no whitespace in between,
     * that `@` starting a word (so an e-mail address never opens the picker),
     * and not an already inserted `@npub1…` the caret is sitting in.
     */
    fun active(text: String, caret: Int): Active? {
        if (caret < 0 || caret > text.length) return null
        var i = caret - 1
        while (i >= 0 && text[i] != '@') {
            if (text[i].isWhitespace()) return null
            i--
        }
        if (i < 0) return null
        if (i > 0 && !text[i - 1].isWhitespace()) return null
        val chip = CHIP_AT.matchAt(text, i)
        if (chip != null && caret <= i + chip.value.length) return null
        return Active(i, text.substring(i + 1, caret))
    }

    data class Edit(val text: String, val caret: Int)

    /**
     * Replace the open query with `@<npub> ` and put the caret after the space.
     * The space is skipped when the text already continues with whitespace, so a
     * mention dropped mid-sentence does not leave a double space.
     */
    fun insert(text: String, active: Active, pubkey: String): Edit {
        val end = minOf(text.length, active.start + 1 + active.query.length)
        val before = text.substring(0, active.start)
        val after = text.substring(end)
        val chip = "@${Nip19.npub(pubkey)}" + if (after.firstOrNull()?.isWhitespace() == true) "" else " "
        return Edit(before + chip + after, before.length + chip.length)
    }

    /**
     * Backspace at a chip's right edge, or just past the space [insert] added,
     * removes the whole chip. Null when the caret is anywhere else, so the
     * field's own Backspace stands.
     */
    fun deleteBackward(text: String, caret: Int): Edit? {
        if (caret < 0 || caret > text.length) return null
        val m = CHIP_BEFORE_CARET.find(text.substring(0, caret)) ?: return null
        pubkeyOfBech32(m.value.trim().drop(1)) ?: return null
        val start = m.range.first
        return Edit(text.substring(0, start) + text.substring(caret), start)
    }

    /** Someone the picker can offer. [account] is hex and is what gets encoded. */
    data class Candidate(val account: String, val name: String)

    /**
     * Who to offer for [query]: name prefix matches first, then names containing
     * it, then an npub typed out by hand. An empty query lists everyone, so a
     * lone `@` is a people picker.
     */
    fun match(candidates: List<Candidate>, query: String, limit: Int = 8): List<Candidate> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return candidates.take(limit)
        val pre = ArrayList<Candidate>()
        val contains = ArrayList<Candidate>()
        val byKey = ArrayList<Candidate>()
        for (c in candidates) {
            val n = c.name.lowercase()
            when {
                n.startsWith(q) -> pre += c
                n.contains(q) -> contains += c
                q.startsWith("npub1") && runCatching { Nip19.npub(c.account) }.getOrDefault("").startsWith(q) -> byKey += c
            }
        }
        return (pre + contains + byKey).take(limit)
    }

    // ── showing the draft ───────────────────────────────────────────────────

    /**
     * The composer's text with every mention shown as `@Name`, plus the offset
     * mapping between the two. A caret inside a chip lands at its end on either
     * side, so a chip edits as one unit while the field still holds the literal
     * npub that gets sent.
     */
    class Display(val text: String, val chips: List<IntRange>, private val spans: List<Span>) {
        /** One chip: [origStart, origEnd) in the draft, [shownStart, shownEnd) on screen. */
        data class Span(val origStart: Int, val origEnd: Int, val shownStart: Int, val shownEnd: Int)

        fun toShown(offset: Int): Int {
            var delta = 0
            for (s in spans) {
                if (offset <= s.origStart) break
                if (offset < s.origEnd) return s.shownEnd
                delta += (s.shownEnd - s.shownStart) - (s.origEnd - s.origStart)
            }
            return offset + delta
        }

        fun toOriginal(offset: Int): Int {
            var delta = 0
            for (s in spans) {
                if (offset <= s.shownStart) break
                if (offset < s.shownEnd) return s.origEnd
                delta += (s.origEnd - s.origStart) - (s.shownEnd - s.shownStart)
            }
            return offset + delta
        }
    }

    fun display(text: String, label: (String) -> String): Display {
        val sb = StringBuilder()
        val spans = ArrayList<Display.Span>()
        var orig = 0
        for (seg in parse(text)) when (seg) {
            is Segment.Text -> { sb.append(seg.value); orig += seg.value.length }
            is Segment.Mention -> {
                val shown = "@" + label(seg.pubkey)
                spans += Display.Span(orig, orig + seg.raw.length, sb.length, sb.length + shown.length)
                sb.append(shown)
                orig += seg.raw.length
            }
        }
        return Display(sb.toString(), spans.map { it.shownStart until it.shownEnd }, spans)
    }
}
