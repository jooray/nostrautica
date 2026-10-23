package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.chat.Mentions.Segment
import today.cypherpunk.nostrautica.protocol.Nip19

/** Mirrors packages/app/src/lib/chat/mentions.test.ts, so the two parsers stay one. */
class MentionsTest {
    // The message White Noise actually sent (owner report 2026-10-23).
    private val wnNpub = "npub1fngg32tel6hy5rnq2dmsevmtezu0th5ql23s9a2p3ake3pdx73yslx5jqt"
    private val wnHex = Nip19.decodeNpub(wnNpub)
    private val otherHex = "b".repeat(64)
    private val otherNpub = Nip19.npub(otherHex)

    @Test fun whiteNoiseAtNpubIsAMention() {
        assertEquals(
            listOf(Segment.Text("Nazdar "), Segment.Mention(wnHex, "@$wnNpub")),
            Mentions.parse("Nazdar @$wnNpub"),
        )
    }

    @Test fun nostrUrisNprofileAndBareNpubNameTheSamePerson() {
        val nprofile = Nip19.nprofile(Nip19.Profile(wnHex, listOf("wss://relay.example")))
        for (form in listOf("nostr:$wnNpub", "nostr:$nprofile", wnNpub, "@nostr:$wnNpub")) {
            assertEquals(
                form,
                listOf(Segment.Text("hi "), Segment.Mention(wnHex, form), Segment.Text(", welcome")),
                Mentions.parse("hi $form, welcome"),
            )
        }
    }

    @Test fun emailLikePathEmbeddedAndCorruptNpubsStayText() {
        // MDK's boundary rule: a letter, digit, `_` or `/` on either side keeps the run literal.
        for (s in listOf(
            "mail me@$wnNpub",
            "https://njump.me/$wnNpub",
            "@${wnNpub}x",
            "@${wnNpub.dropLast(1)}q", // checksum broken
            "nostr:note1qqqqqqqqqqqqqq", // not a person
        )) {
            assertTrue(s, Mentions.parse(s).all { it is Segment.Text })
        }
    }

    @Test fun severalMentionsKeepTheTextBetween() {
        val segs = Mentions.parse("@$wnNpub and @$otherNpub!")
        assertEquals(listOf("m", "t", "m", "t"), segs.map { if (it is Segment.Mention) "m" else "t" })
    }

    @Test fun plainTextIsUntouched() {
        assertEquals(listOf(Segment.Text("no one here")), Mentions.parse("no one here"))
        assertEquals(emptyList<Segment>(), Mentions.parse(""))
    }

    @Test fun pTagsAreDistinctInFirstSeenOrder() {
        // MDK mention_p_tags: what MarmotKit's sendText adds to the kind-9.
        assertEquals(
            listOf(listOf("p", otherHex), listOf("p", wnHex)),
            Mentions.pTags("@$otherNpub @$wnNpub nostr:$otherNpub"),
        )
        assertEquals(emptyList<List<String>>(), Mentions.pTags("nobody"))
    }

    @Test fun shortNpubKeepsThePrefixAndTheLastFour() {
        assertEquals("npub1fngg…5jqt", Mentions.shortNpub(wnHex))
    }

    @Test fun activeOpensOnAWordStartingAt() {
        assertEquals(Mentions.Active(3, "ju"), Mentions.active("hi @ju", 6))
        assertEquals(Mentions.Active(0, ""), Mentions.active("@", 1))
        assertNull(Mentions.active("mail a@b", 8))
        assertNull(Mentions.active("hi @ju there", 12))
    }

    @Test fun activeDoesNotReopenInsideAnInsertedChip() {
        val text = "@$wnNpub"
        assertNull(Mentions.active(text, text.length))
        assertNull(Mentions.active(text, 5))
    }

    @Test fun insertWritesTheExactWhiteNoiseFormWithOneSpace() {
        val r = Mentions.insert("hi @ju", Mentions.Active(3, "ju"), wnHex)
        assertEquals("hi @$wnNpub ", r.text)
        assertEquals(r.text.length, r.caret)
        // Mid-sentence: the following space is reused, not doubled.
        val mid = Mentions.insert("hi @ju there", Mentions.Active(3, "ju"), wnHex)
        assertEquals("hi @$wnNpub there", mid.text)
        assertEquals("hi @$wnNpub".length, mid.caret)
        assertEquals(listOf(listOf("p", wnHex)), Mentions.pTags(r.text))
    }

    @Test fun backspaceRemovesAWholeChipWithOrWithoutItsSpace() {
        val text = "hi @$wnNpub "
        assertEquals(Mentions.Edit("hi ", 3), Mentions.deleteBackward(text, text.length))
        assertEquals(Mentions.Edit("hi  ", 3), Mentions.deleteBackward(text, text.length - 1))
        assertNull(Mentions.deleteBackward("hello", 5))
    }

    @Test fun matchRanksPrefixBeforeSubstringAndFindsATypedNpub() {
        val people = listOf(
            Mentions.Candidate(wnHex, "Juraj"),
            Mentions.Candidate(otherHex, "Mária Juraj"),
            Mentions.Candidate("c".repeat(64), "stallion"),
        )
        assertEquals(listOf("Juraj", "Mária Juraj"), Mentions.match(people, "jur").map { it.name })
        assertEquals(3, Mentions.match(people, "").size)
        assertEquals(listOf(people[0]), Mentions.match(people, wnNpub.take(12)))
    }

    @Test fun displayShowsNamesAndMapsTheCaretAroundChips() {
        val text = "hi @$wnNpub and you"
        val d = Mentions.display(text) { if (it == wnHex) "Juraj" else "?" }
        assertEquals("hi @Juraj and you", d.text)
        assertEquals(listOf(3 until 9), d.chips)
        // Before the chip: identity. Inside it: its end. After it: shifted.
        assertEquals(3, d.toShown(3))
        assertEquals(9, d.toShown(10))
        val chipEnd = 3 + 1 + wnNpub.length
        assertEquals(9, d.toShown(chipEnd))
        assertEquals(d.text.length, d.toShown(text.length))
        assertEquals(3, d.toOriginal(3))
        assertEquals(chipEnd, d.toOriginal(5))
        assertEquals(chipEnd, d.toOriginal(9))
        assertEquals(text.length, d.toOriginal(d.text.length))
        // No mentions: the text and offsets pass through.
        val plain = Mentions.display("hello") { it }
        assertEquals("hello", plain.text)
        assertEquals(4, plain.toShown(4))
        assertEquals(4, plain.toOriginal(4))
    }
}
