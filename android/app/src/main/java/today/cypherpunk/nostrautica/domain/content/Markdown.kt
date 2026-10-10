package today.cypherpunk.nostrautica.domain.content

/**
 * The PWA's minimal markdown (social/markdown.ts) as a small syntax tree that
 * Compose renders natively, so no organizer- or feed-authored text is ever
 * interpreted as markup the app didn't intend.
 *
 * Same constructs and the same precedence as the web: fenced code, `#`–`###`
 * headings, nested (un)ordered lists, pipe tables, paragraphs with hard line
 * breaks; inline code spans, then images, then links, then emphasis, then bare
 * URLs. Two additions the native renderer can afford: `>` blockquotes and
 * `nostr:` references, which become links. Anything else stays literal.
 */
object Markdown {
    sealed interface Inline {
        data class Text(
            val text: String,
            val bold: Boolean = false,
            val italic: Boolean = false,
            val code: Boolean = false,
            /** A link target: https/http URL or a `nostr:` URI. */
            val link: String? = null,
        ) : Inline
        data class Image(val url: String, val alt: String) : Inline
    }

    data class ListItem(val depth: Int, val ordered: Boolean, val number: Int, val content: List<Inline>)

    sealed interface Block {
        data class Heading(val level: Int, val content: List<Inline>) : Block
        data class Paragraph(val content: List<Inline>) : Block
        data class ListBlock(val items: List<ListItem>) : Block
        data class Table(val header: List<List<Inline>>, val rows: List<List<List<Inline>>>) : Block
        data class Code(val text: String) : Block
        data class Quote(val blocks: List<Block>) : Block
    }

    private val SAFE_URL = Regex("""^https?://[^\s<>"')]+$""")
    private val CODE_SPAN = Regex("`([^`]+)`")
    private val IMAGE = Regex("""!\[([^\]]*)]\(([^)\s]+)\)""")
    private val LINK = Regex("""\[([^\]]+)]\(([^)\s]+)\)""")
    private val BOLD = Regex("""\*\*([^*]+)\*\*""")
    private val ITALIC = Regex("""\*([^*]+)\*""")
    private val BARE = Regex("""(^|\s)(https?://[^\s<>"')]+)|nostr:((?:npub|nprofile|note|nevent|naddr)1[0-9a-z]+)""")
    private val LIST_ITEM = Regex("""^(\s*)(?:([-*])|(\d+)[.)])\s+(.*)$""")
    private val TABLE_SEPARATOR = Regex("""^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$""")
    private val HEADING = Regex("""^(#{1,3})\s+(.*)$""", RegexOption.DOT_MATCHES_ALL)
    private val FENCE = Regex("""(?:^|\n)```[^\n`]*\n([\s\S]*?)\n```(?=\n|$)""")

    fun parse(md: String): List<Block> {
        val src = md.replace("\r\n", "\n")
        val out = mutableListOf<Block>()
        var last = 0
        for (m in FENCE.findAll(src)) {
            val before = src.substring(last, m.range.first)
            if (before.isNotBlank()) out += blocks(before)
            out += Block.Code(m.groupValues[1])
            last = m.range.last + 1
        }
        val rest = src.substring(last)
        if (rest.isNotBlank()) out += blocks(rest)
        return out
    }

    private fun blocks(text: String): List<Block> =
        text.split(Regex("\n{2,}")).mapNotNull { raw ->
            val b = raw.trim('\n')
            if (b.isBlank()) return@mapNotNull null
            val lines = b.split("\n")
            HEADING.matchEntire(b)?.let { h -> return@mapNotNull Block.Heading(h.groupValues[1].length, inline(h.groupValues[2].trim())) }
            if (lines.all { it.trimStart().startsWith(">") }) {
                val inner = lines.joinToString("\n") { it.trimStart().removePrefix(">").removePrefix(" ") }
                return@mapNotNull Block.Quote(blocks(inner))
            }
            if (lines.all { LIST_ITEM.matches(it) }) return@mapNotNull listBlock(lines)
            if (isTable(lines)) return@mapNotNull table(lines)
            Block.Paragraph(inline(b.trim()))
        }

    private fun listBlock(lines: List<String>): Block.ListBlock {
        val stack = ArrayDeque<Pair<Int, Boolean>>() // indent, ordered
        val counters = ArrayDeque<Int>()
        val items = mutableListOf<ListItem>()
        for (line in lines) {
            val m = LIST_ITEM.matchEntire(line)!!
            val indent = m.groupValues[1].length
            val ordered = m.groupValues[2].isEmpty()
            while (stack.isNotEmpty() && stack.last().first > indent) { stack.removeLast(); counters.removeLast() }
            if (stack.isNotEmpty() && stack.last().first == indent && stack.last().second != ordered) { stack.removeLast(); counters.removeLast() }
            if (stack.isEmpty() || stack.last().first < indent) {
                stack.addLast(indent to ordered); counters.addLast(0)
            }
            val n = counters.removeLast() + 1
            counters.addLast(n)
            items += ListItem(stack.size - 1, ordered, n, inline(m.groupValues[4]))
        }
        return Block.ListBlock(items)
    }

    private fun isTable(lines: List<String>) =
        lines.size >= 2 && lines[0].contains('|') && TABLE_SEPARATOR.matches(lines[1]) && lines[1].contains('-')

    private fun cells(line: String): List<String> {
        var l = line.trim()
        if (l.startsWith("|")) l = l.substring(1)
        if (l.endsWith("|")) l = l.dropLast(1)
        return l.split("|").map { it.trim() }
    }

    private fun table(lines: List<String>) = Block.Table(
        header = cells(lines[0]).map(::inline),
        rows = lines.drop(2).filter { it.isNotBlank() }.map { cells(it).map(::inline) },
    )

    // ── Inline ──────────────────────────────────────────────────────────────

    /** Inline markdown, one construct at a time; text a construct emitted is never re-read. */
    fun inline(s: String): List<Inline> {
        val out = mutableListOf<Inline>()
        split(s, CODE_SPAN, { out += images(it) }) { m -> out += Inline.Text(m.groupValues[1], code = true) }
        return merge(out)
    }

    private fun images(s: String): List<Inline> {
        val out = mutableListOf<Inline>()
        split(s, IMAGE, { out += links(it) }) { m ->
            val (alt, url) = m.destructured
            if (SAFE_URL.matches(url)) out += Inline.Image(url, alt) else out += links(m.value)
        }
        return out
    }

    private fun links(s: String): List<Inline> {
        val out = mutableListOf<Inline>()
        split(s, LINK, { out += emphasis(it, null) }) { m ->
            val (text, url) = m.destructured
            if (SAFE_URL.matches(url)) out += emphasis(text, url, bare = false) else out += emphasis(m.value, null)
        }
        return out
    }

    private fun emphasis(s: String, link: String?, bare: Boolean = true): List<Inline> {
        val out = mutableListOf<Inline>()
        split(s, BOLD, { plain ->
            split(plain, ITALIC, { out += leaf(it, link, bold = false, italic = false, bare) }) { m ->
                out += leaf(m.groupValues[1], link, bold = false, italic = true, bare)
            }
        }) { m -> out += leaf(m.groupValues[1], link, bold = true, italic = false, bare) }
        return out
    }

    /** Bare URLs and `nostr:` references in plain text (not inside a link's own text). */
    private fun leaf(s: String, link: String?, bold: Boolean, italic: Boolean, bare: Boolean): List<Inline> {
        if (!bare || link != null) return listOf(Inline.Text(s, bold, italic, link = link))
        val out = mutableListOf<Inline>()
        split(s, BARE, { out += Inline.Text(it, bold, italic) }) { m ->
            if (m.groupValues[2].isNotEmpty()) {
                if (m.groupValues[1].isNotEmpty()) out += Inline.Text(m.groupValues[1], bold, italic)
                out += Inline.Text(m.groupValues[2], bold, italic, link = m.groupValues[2])
            } else {
                out += Inline.Text(m.value, bold, italic, link = m.value)
            }
        }
        return out
    }

    private inline fun split(s: String, re: Regex, text: (String) -> Unit, match: (MatchResult) -> Unit) {
        var last = 0
        for (m in re.findAll(s)) {
            if (m.range.first > last) text(s.substring(last, m.range.first))
            match(m)
            last = m.range.last + 1
        }
        if (last < s.length) text(s.substring(last))
    }

    /** Join adjacent runs with the same style, so a renderer gets few, long spans. */
    private fun merge(list: List<Inline>): List<Inline> {
        val out = mutableListOf<Inline>()
        for (i in list) {
            val prev = out.lastOrNull()
            if (i is Inline.Text && prev is Inline.Text && prev.copy(text = "") == i.copy(text = "")) {
                out[out.size - 1] = prev.copy(text = prev.text + i.text)
            } else if (!(i is Inline.Text && i.text.isEmpty())) out += i
        }
        return out
    }

    /** Plain text of some inlines (image alt text included), for previews and accessibility. */
    fun plain(list: List<Inline>): String = list.joinToString("") { when (it) { is Inline.Text -> it.text; is Inline.Image -> it.alt } }
}
