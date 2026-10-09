package today.cypherpunk.nostrautica.content

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.content.ExternalVideo
import today.cypherpunk.nostrautica.domain.content.Markdown
import today.cypherpunk.nostrautica.domain.content.Markdown.Block
import today.cypherpunk.nostrautica.domain.content.Markdown.Inline
import today.cypherpunk.nostrautica.domain.content.NoteTokens
import today.cypherpunk.nostrautica.domain.content.NoteTokens.Token
import today.cypherpunk.nostrautica.domain.content.StreamingGcm
import today.cypherpunk.nostrautica.domain.content.Vtt
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Media
import today.cypherpunk.nostrautica.protocol.Nip19
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlin.random.Random

class RenderingTest {
    // ── Markdown ────────────────────────────────────────────────────────────

    @Test fun blocks() {
        val md = "# Title\n\nPara one\nline two\n\n- a\n  - b\n- c\n\n1. x\n2. y\n\n> quoted *text*\n\n```kotlin\nval x = **1**\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n#### not a heading"
        val b = Markdown.parse(md)
        assertEquals(Block.Heading(1, listOf(Inline.Text("Title"))), b[0])
        assertEquals(Block.Paragraph(listOf(Inline.Text("Para one\nline two"))), b[1])
        val list = b[2] as Block.ListBlock
        assertEquals(listOf(0, 1, 0), list.items.map { it.depth })
        assertFalse(list.items[0].ordered)
        val ol = b[3] as Block.ListBlock
        assertEquals(listOf(1, 2), ol.items.map { it.number })
        assertTrue(ol.items.all { it.ordered })
        val q = b[4] as Block.Quote
        assertEquals(Block.Paragraph(listOf(Inline.Text("quoted "), Inline.Text("text", italic = true))), q.blocks.single())
        assertEquals(Block.Code("val x = **1**"), b[5])
        val t = b[6] as Block.Table
        assertEquals(listOf("A", "B"), t.header.map(Markdown::plain))
        assertEquals(listOf(listOf("1", "2")), t.rows.map { r -> r.map(Markdown::plain) })
        assertTrue(b[7] is Block.Paragraph)
    }

    @Test fun inlinePrecedence() {
        val i = Markdown.inline("`**no**` **bold** *it* [a *b*](https://x.example/p) ![alt](https://x.example/i.png) see https://y.example/q nostr:npub1abc")
        assertEquals(Inline.Text("**no**", code = true), i[0])
        assertTrue(Inline.Text("bold", bold = true) in i)
        assertTrue(Inline.Text("it", italic = true) in i)
        assertTrue(Inline.Text("a ", link = "https://x.example/p") in i)
        assertTrue(Inline.Text("b", italic = true, link = "https://x.example/p") in i)
        assertTrue(Inline.Image("https://x.example/i.png", "alt") in i)
        assertTrue(Inline.Text("https://y.example/q", link = "https://y.example/q") in i)
        assertTrue(Inline.Text("nostr:npub1abc", link = "nostr:npub1abc") in i)
    }

    @Test fun unsafeUrlsStayLiteral() {
        val i = Markdown.inline("[x](javascript:alert(1)) ![y](data:image/png;base64,AAA)")
        assertTrue(i.none { it is Inline.Image })
        assertTrue(i.filterIsInstance<Inline.Text>().none { it.link?.startsWith("javascript") == true })
        assertTrue(Markdown.plain(i).contains("[x](javascript:alert(1))"))
    }

    // ── Note tokens ─────────────────────────────────────────────────────────

    @Test fun noteTokens() {
        val t = NoteTokens.parse("hi nostr:npub1xyz look https://a.example/p.jpg and https://a.example/v.mp4 or https://a.example/page nostr:note1qq", listOf())
        assertEquals(Token.Text("hi "), t[0])
        assertEquals(Token.Mention("npub1xyz"), t[1])
        assertTrue(Token.Image("https://a.example/p.jpg") in t)
        assertTrue(Token.Video("https://a.example/v.mp4") in t)
        assertTrue(Token.Link("https://a.example/page") in t)
        assertTrue(Token.Embed("note1qq") in t)
        assertEquals(listOf(Token.Image("https://b.example/x")), NoteTokens.parse("https://b.example/x", NoteTokens.imetaUrls(listOf(listOf("imeta", "url https://b.example/x", "m image/png")))))
        assertEquals("r", NoteTokens.replyTo(listOf(listOf("e", "root", "", "root"), listOf("e", "r", "", "reply"))))
        assertEquals("b", NoteTokens.replyTo(listOf(listOf("e", "a"), listOf("e", "b"))))
        assertNull(NoteTokens.replyTo(emptyList()))
        val naddr = Nip19.naddr(Nip19.Addr(30023, EID, "d1"))
        assertEquals(NoteTokens.Ref.Address(30023, EID, "d1", emptyList()), NoteTokens.decode(naddr))
    }

    // ── External video ──────────────────────────────────────────────────────

    @Test fun youtubeIds() {
        val id = "dQw4w9WgXcQ"
        for (u in listOf("https://www.youtube.com/watch?v=$id", "https://youtu.be/$id", "https://www.youtube.com/embed/$id", "https://youtube.com/shorts/$id", "https://m.youtube.com/live/$id?x=1")) {
            assertEquals(u, id, ExternalVideo.youTubeId(u))
        }
        assertNull(ExternalVideo.youTubeId("http://youtu.be/$id"))
        assertNull(ExternalVideo.youTubeId("https://user:pw@youtu.be/$id"))
        assertNull(ExternalVideo.youTubeId("https://vimeo.com/123"))
        assertEquals("cdn.example", ExternalVideo.host("https://cdn.example/talk.mp4"))
        assertNull(ExternalVideo.directUrl("ftp://cdn.example/talk.mp4"))
    }

    // ── VTT ─────────────────────────────────────────────────────────────────

    @Test fun vtt() {
        assertEquals("01:02:03.500", Vtt.timestamp(3723.5))
        assertEquals("00:00:01.000", Vtt.timestamp(0.9999))
        assertEquals("WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nA &lt;b&gt;\nC\n", Vtt.singleCue("A <b>\n\n\nC", 10.0))
        val text = (1..40).joinToString(" ") { "Sentence number $it is here." }
        val doc = Vtt.forTranscript(text, 120.0)
        val cues = doc.split("\n\n").drop(1)
        assertTrue(cues.size > 3)
        assertTrue(cues.last().contains("--> 00:02:00.000"))
        assertTrue(doc.startsWith("WEBVTT\n\n1\n00:00:00.000 --> "))
        assertTrue(Vtt.forTranscript(text, null).contains("--> 24:00:00.000"))
        assertEquals("WEBVTT\n", Vtt.forTranscript("  ", 10.0))
        assertEquals(listOf("one two"), Vtt.splitForCues("one   two", 1))
    }

    // ── Streaming AES-GCM ───────────────────────────────────────────────────

    @Test fun streamingGcmMatchesTheProtocolEncryption() {
        val rnd = Random(7)
        for (size in listOf(1, 15, 16, 17, 1000, 65_536, 65_537, 200_003)) {
            val plain = rnd.nextBytes(size)
            val enc = Media.encrypt("talk", plain, "video/mp4", 1.0, listOf("https://b.example/x"))
            val out = ByteArrayOutputStream()
            val r = StreamingGcm.decrypt(
                ByteArrayInputStream(enc.ciphertext), enc.ciphertext.size.toLong(),
                Bytes.fromBase64(enc.descriptor.decryptionKey), Bytes.fromBase64(enc.descriptor.decryptionNonce), enc.descriptor.ox, out,
            )
            assertTrue("size $size: ${r.reason}", r.ok)
            assertArrayEquals(plain, out.toByteArray())
        }
    }

    @Test fun streamingGcmRejectsTampering() {
        val plain = Random(3).nextBytes(5000)
        val enc = Media.encrypt("talk", plain, "video/mp4", 1.0, listOf("https://b.example/x"))
        val key = Bytes.fromBase64(enc.descriptor.decryptionKey)
        val nonce = Bytes.fromBase64(enc.descriptor.decryptionNonce)
        val flipped = enc.ciphertext.copyOf().also { it[100] = (it[100].toInt() xor 1).toByte() }
        assertFalse(StreamingGcm.decrypt(ByteArrayInputStream(flipped), flipped.size.toLong(), key, nonce, enc.descriptor.ox, ByteArrayOutputStream()).ok)
        val badTag = enc.ciphertext.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertFalse(StreamingGcm.decrypt(ByteArrayInputStream(badTag), badTag.size.toLong(), key, nonce, enc.descriptor.ox, ByteArrayOutputStream()).ok)
        val wrongOx = StreamingGcm.decrypt(ByteArrayInputStream(enc.ciphertext), enc.ciphertext.size.toLong(), key, nonce, "0".repeat(64), ByteArrayOutputStream())
        assertFalse(wrongOx.ok)
        assertEquals("plaintext sha256 mismatch (ox)", wrongOx.reason)
    }
}
