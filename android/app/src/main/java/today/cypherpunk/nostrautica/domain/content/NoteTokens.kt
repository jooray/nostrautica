package today.cypherpunk.nostrautica.domain.content

import today.cypherpunk.nostrautica.protocol.Bech32
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Nip19

/**
 * Short-note rendering (social/render.ts): NIP-21 mentions, imeta/inline
 * images and videos, links, and quoted-note embeds. Pure, so it is testable;
 * NoteView maps the tokens to composables.
 */
object NoteTokens {
    sealed interface Token {
        data class Text(val value: String) : Token
        data class Image(val url: String) : Token
        data class Video(val url: String) : Token
        data class Link(val url: String) : Token
        /** A person: npub / nprofile. */
        data class Mention(val bech32: String) : Token
        /** A quoted note/event: note / nevent / naddr. */
        data class Embed(val bech32: String) : Token
    }

    private val COMBINED = Regex("""nostr:((?:npub|nprofile|note|nevent|naddr)1[0-9a-z]+)|(https?://\S+)""", RegexOption.IGNORE_CASE)
    private val IMAGE_EXT = Regex("""\.(png|jpe?g|gif|webp|avif|bmp)(\?\S*)?$""", RegexOption.IGNORE_CASE)
    private val VIDEO_EXT = Regex("""\.(mp4|webm|mov|m4v|ogv)(\?\S*)?$""", RegexOption.IGNORE_CASE)

    fun parse(content: String, imetaUrls: Collection<String> = emptyList()): List<Token> {
        val imeta = imetaUrls.toSet()
        val tokens = mutableListOf<Token>()
        var last = 0
        for (m in COMBINED.findAll(content)) {
            if (m.range.first > last) tokens += Token.Text(content.substring(last, m.range.first))
            val match = m.value
            tokens += when {
                match.startsWith("nostr:", ignoreCase = true) -> {
                    val b = match.substring(6)
                    if (b.startsWith("npub") || b.startsWith("nprofile")) Token.Mention(b) else Token.Embed(b)
                }
                match in imeta || IMAGE_EXT.containsMatchIn(match) -> Token.Image(match)
                VIDEO_EXT.containsMatchIn(match) -> Token.Video(match)
                else -> Token.Link(match)
            }
            last = m.range.last + 1
        }
        if (last < content.length) tokens += Token.Text(content.substring(last))
        return tokens
    }

    /** Image URLs advertised in imeta tags (`url …` fields). */
    fun imetaUrls(tags: List<List<String>>): List<String> =
        tags.filter { it.firstOrNull() == "imeta" }.flatMap { t -> t.drop(1).filter { it.startsWith("url ") }.map { it.substring(4).trim() } }

    /** A reply's parent (NIP-10): the "reply" marker, then "root", else the last positional e-tag. */
    fun replyTo(tags: List<List<String>>): String? {
        val es = tags.filter { it.size >= 2 && it[0] == "e" }
        if (es.isEmpty()) return null
        return (es.firstOrNull { it.getOrNull(3) == "reply" } ?: es.firstOrNull { it.getOrNull(3) == "root" } ?: es.last())[1]
    }

    /** What a NIP-19 reference points at. */
    sealed interface Ref {
        data class Event(val id: String, val relays: List<String>) : Ref
        data class Address(val kind: Int, val pubkey: String, val d: String, val relays: List<String>) : Ref
        data class Profile(val pubkey: String) : Ref
    }

    fun decode(bech32: String): Ref? = runCatching {
        val b = bech32.removePrefix("nostr:")
        when {
            b.startsWith("npub1") -> Ref.Profile(Nip19.decodeNpub(b))
            b.startsWith("nprofile1") -> Ref.Profile(Nip19.decodeNprofile(b).pubkey)
            b.startsWith("naddr1") -> Nip19.decodeNaddr(b).let { Ref.Address(it.kind, it.pubkey, it.identifier, it.relays) }
            b.startsWith("note1") -> {
                val (hrp, data) = Bech32.decode(b)
                require(hrp == "note" && data.size == 32)
                Ref.Event(Bytes.toHex(data), emptyList())
            }
            b.startsWith("nevent1") -> {
                val (hrp, data) = Bech32.decode(b)
                require(hrp == "nevent")
                var id: String? = null
                val relays = mutableListOf<String>()
                var i = 0
                while (i + 2 <= data.size) {
                    val t = data[i].toInt() and 0xff
                    val l = data[i + 1].toInt() and 0xff
                    require(i + 2 + l <= data.size)
                    val v = data.copyOfRange(i + 2, i + 2 + l)
                    if (t == 0 && l == 32) id = Bytes.toHex(v)
                    if (t == 1) relays += v.toString(Charsets.UTF_8)
                    i += 2 + l
                }
                Ref.Event(id!!, relays)
            }
            else -> null
        }
    }.getOrNull()
}
