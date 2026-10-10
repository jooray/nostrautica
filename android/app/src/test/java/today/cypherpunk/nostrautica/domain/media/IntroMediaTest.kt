package today.cypherpunk.nostrautica.domain.media

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.Media
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.ProfileSubmissionContent
import today.cypherpunk.nostrautica.protocol.jsonObjectOf

class IntroMediaTest {
    private fun clip(seed: Int, kind: String = "intro"): MediaDescriptor =
        Media.encrypt(kind, Bytes.utf8("clip $seed"), "video/mp4", 12.0).descriptor.copy(url = listOf("https://blossom.band/x$seed"))

    private val coord = "31923:${"e".repeat(64)}:meetup"

    @Test fun selfCopyRoundTrips() {
        val m = clip(1)
        val json = IntroMedia.selfCopyJson(coord, 4, AttendeeProfile("hi", listOf("rust"), "co-founder", emptyList()), listOf(m), "text intro", 2)
        val o = jsonObjectOf(json)!!
        assertEquals(2, (o["v"] as JsonPrimitive).content.toInt())
        assertEquals(coord, (o["a"] as JsonPrimitive).content)
        assertEquals("aes-gcm", ((o["media"] as JsonArray)[0] as JsonObject)["encryption-algorithm"].let { (it as JsonPrimitive).content })
        val back = IntroMedia.parseSelfCopy(json)!!
        assertEquals(4L, back.rev)
        assertEquals(2L, back.correctionRev)
        assertEquals("text intro", back.introText)
        assertEquals(listOf(m), back.media)
        assertEquals("co-founder", back.profile?.lookingFor)
        assertTrue(back.hasIntro)
    }

    @Test fun selfCopyOmitsWhatIsAbsent() {
        val o = jsonObjectOf(IntroMedia.selfCopyJson(coord, 0, null, emptyList(), null, null))!!
        assertFalse("profile" in o)
        assertFalse("intro_text" in o)
        assertFalse("correction_rev" in o)
        assertEquals(0, (o["rev"] as JsonPrimitive).content.toInt())
        assertFalse(IntroMedia.parseSelfCopy(o.toString())!!.hasIntro)
    }

    @Test fun parsesForeignAndPartialSelfCopies() {
        // A TS self-copy with a bad media item: keep what parses, drop the rest.
        val s = IntroMedia.parseSelfCopy("""{"v":2,"a":"$coord","rev":3.0,"media":[{"kind":"intro"}],"intro_text":"hey"}""")!!
        assertEquals(3L, s.rev)
        assertTrue(s.media.isEmpty())
        assertTrue(s.hasIntro)
        assertNull(IntroMedia.parseSelfCopy("not json"))
    }

    @Test fun libraryJsonCarriesNullAAndTheDateSidecar() {
        val m = clip(2)
        val json = IntroMedia.libraryJson(ReuseLibrary(listOf(m), emptyList(), mapOf(m.x to 1700000000L), known = true))
        val o = jsonObjectOf(json)!!
        assertEquals(JsonNull, o["a"])
        assertFalse("intro_texts" in o)
        assertEquals(1700000000L, (o["media_at"] as JsonObject)[m.x].let { (it as JsonPrimitive).content.toLong() })
        val back = IntroMedia.parseLibrary(json)!!
        assertEquals(listOf(m), back.media)
        assertEquals(mapOf(m.x to 1700000000L), back.at)
        assertTrue(back.known)
    }

    @Test fun libraryMergeIsAppendOnly() {
        val a = clip(1)
        val b = clip(2)
        val c = clip(3)
        val prior = ReuseLibrary(listOf(a), listOf("old"), mapOf(a.x to 100L), known = false)
        val existing = ReuseLibrary(listOf(b), listOf("t1", "t2"), mapOf(b.x to 200L), known = true)
        val merged = LibraryMerge.merge(prior, existing, listOf(c, b), listOf("t1"), now = 999)
        // Union restores a clip the relays didn't return; dedup by x.
        assertEquals(listOf(a.x, b.x, c.x), merged.media.map { it.x })
        // Only genuinely new clips get stamped now.
        assertEquals(100L, merged.at[a.x])
        assertEquals(200L, merged.at[b.x])
        assertEquals(999L, merged.at[c.x])
        // Re-adding a text moves it to newest.
        assertEquals(listOf("old", "t2", "t1"), merged.texts)
    }

    @Test fun libraryTextsAreCapped() {
        val texts = (1..30).map { "t$it" }
        val merged = LibraryMerge.merge(null, ReuseLibrary(emptyList(), emptyList(), emptyMap(), true), emptyList(), texts, 1)
        assertEquals(Limits.MAX_LIBRARY_TEXTS, merged.texts.size)
        assertEquals("t30", merged.texts.last())
    }

    @Test fun aggregateOutcome() {
        assertEquals(Outcome.PUBLISHED, SubmitOutcome(Outcome.PUBLISHED, Outcome.PUBLISHED, Outcome.PUBLISHED).aggregate)
        assertEquals(Outcome.QUEUED, SubmitOutcome(Outcome.QUEUED, Outcome.PUBLISHED, Outcome.PUBLISHED).aggregate)
        // A skipped library write is reported, not collapsed into success.
        assertEquals(Outcome.QUEUED, SubmitOutcome(Outcome.PUBLISHED, Outcome.PUBLISHED, Outcome.SKIPPED).aggregate)
    }

    @Test fun submissionOverTheMediaCapIsRefusedBeforeSigning() {
        val media = (1..Limits.MAX_SUBMISSION_MEDIA + 1).map { clip(it) }
        val s = ProfileSubmissionContent(rev = 0, profile = AttendeeProfile(), media = media)
        val e = assertThrows(UserFacingError::class.java) { IntroMedia.assertSubmittable(s) }
        assertEquals("submit.error.invalid", e.key)
        assertEquals("media", e.params["field"])
        IntroMedia.assertSubmittable(s.copy(media = media.take(Limits.MAX_SUBMISSION_MEDIA)))
    }
}
