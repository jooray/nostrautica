package today.cypherpunk.nostrautica.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Config, roster and payload schemas against what the TS implementation produced. */
class WireVectorsTest {
    private val ts = Json.parseToJsonElement(javaClass.classLoader!!.getResource("ts-vectors.json")!!.readText()).jsonObject
    private val pk = ts["pk"]!!.jsonPrimitive.content

    private fun tags(e: JsonArray) = e.map { t -> t.jsonArray.map { it.jsonPrimitive.content } }

    @Test fun configBuildMatchesTsTags() {
        val cfg = EventConfig(
            d = "plan-b:2026", eidPubkey = pk, inbox = "ab".repeat(32), coordinator = "cd".repeat(32), coordinatorGen = 3,
            relays = listOf("wss://nos.lol"), chatRelays = listOf("wss://relay.eu.whitenoise.chat"), blossom = listOf("https://blossom.band"),
            maxVideoSec = 0, maxTalkSec = 900, matching = true, matchVisibility = "pair", approval = "manual+invite", eck = 4,
            nostrContext = 100, lang = "sk", talks = "prerecord-first", chat = listOf("marmot"), retentionDays = 30,
        )
        assertEquals(tags(ts["configTags"]!!.jsonArray), cfg.toTags())
        assertEquals(cfg, EventConfig.parse(pk, cfg.toTags()))
    }

    @Test fun hostileConfigParsesLikeTs() {
        val got = EventConfig.parse(pk, tags(ts["hostileTags"]!!.jsonArray))
        val want = ts["hostileParsed"]!!.jsonObject
        assertEquals(want["relays"]!!.jsonArray.map { it.jsonPrimitive.content }, got.relays)
        assertEquals(want["chatRelays"]!!.jsonArray.map { it.jsonPrimitive.content }, got.chatRelays)
        assertEquals(emptyList<String>(), got.blossom)
        assertEquals(want["maxVideoSec"]!!.jsonPrimitive.int, got.maxVideoSec)
        assertEquals(want["maxTalkSec"]!!.jsonPrimitive.int, got.maxTalkSec)
        assertEquals(want["approval"]!!.jsonPrimitive.content, got.approval)
        assertEquals(want["talks"]!!.jsonPrimitive.content, got.talks)
        assertEquals(want["lang"]!!.jsonPrimitive.content, got.lang)
        assertEquals(want["eck"]!!.jsonPrimitive.int, got.eck)
        assertEquals(listOf("marmot"), got.chat)
        assertNull(got.coordinator) // two-element coordinator tag = no coordinator
        assertNull(got.retentionDays)
    }

    @Test fun newerConfigAsksForAnUpdate() {
        val t = listOf(listOf("d", "x"), listOf("v", "3"), listOf("inbox", "ab".repeat(32)))
        assertThrows(Wire.NewerProtocolVersion::class.java) { EventConfig.parse(pk, t) }
    }

    @Test fun rosterPaginatesLikeTs() {
        val input = Wire.json.decodeFromJsonElement(RosterContent.serializer(), ts["rosterInput"]!!)
        val pages = Roster.split(input)
        val want = ts["rosterPages"]!!.jsonArray.map { it.jsonObject }
        assertEquals(want.size, pages.size)
        pages.zip(want).forEach { (p, w) ->
            assertEquals(w["v"]!!.jsonPrimitive.int, p.v)
            assertEquals(w["pages"]!!.jsonPrimitive.intOrNull, p.pages)
            assertEquals(w["n"]!!.jsonPrimitive.int, p.attendees.size)
            assertEquals(w["first"]!!.jsonPrimitive.content, p.attendees.first().pubkey)
            p.validate()
        }
        val merged = Roster.merge(pages)
        assertEquals(600, merged.attendees.size)
        assertEquals("12".repeat(32), merged.nostrGroupId)
        assertEquals(listOf("x:1", "x:2"), Roster.continuationDs("x", 3))
    }

    @Test fun smallRosterIsUntouched() {
        val r = RosterContent(2, 1, null, null, listOf(RosterAttendee(pk, "d", "attendee")))
        assertSame(r, Roster.split(r).single())
    }

    @Test fun parsesTsDirectoryEntry() {
        val raw = ts["directoryEntry"]!!
        val r = Wire.parseSafe(DirectoryEntryContent.serializer(), raw)
        assertTrue(r is Wire.Result.Ok)
        val e = (r as Wire.Result.Ok).value
        assertEquals("Ada", e.name)
        assertEquals(12.5, e.media.single().duration)
        assertEquals(listOf("x"), e.aiProfile!!.interests)
        // and what we emit, the TS side reads back the same object
        val back = Json.parseToJsonElement(Wire.encode(DirectoryEntryContent.serializer(), e)) as JsonObject
        assertEquals((raw as JsonObject)["media"], back["media"])
    }

    @Test fun newerPayloadIsClassified() {
        val r = Wire.parseSafe(DirectoryEntryContent.serializer(), ts["newerPayload"]!!)
        assertEquals(Wire.Result.Newer(3), r)
    }

    @Test fun attestationRules() {
        val ok = ChatKeyAttestationContent(a = "x", op = "add", chatPubkey = pk, label = "Pixel", proof = "ab".repeat(64))
        ok.validate()
        assertThrows(Wire.InvalidPayload::class.java) { ok.copy(proof = null).validate() }
        assertThrows(Wire.InvalidPayload::class.java) { ok.copy(op = "link").validate() }
        assertEquals("ABCD2345", ChatKeyAttestationContent.normalizeLinkCode("abcd-23 45"))
    }

    @Test fun eventPageMergeSplitRoundTrips() {
        val pub = listOf(MenuItem("A", "https://a"), MenuItem("B", "https://b"))
        val priv = listOf(MenuItem("M", "https://m", pos = 1))
        val merged = EventPage.mergeMenu(pub, priv)
        assertEquals(listOf("A", "M", "B"), merged.map { it.item.label })
        val (p, q) = EventPage.split(merged)
        assertEquals(pub, p)
        assertEquals(listOf(MenuItem("M", "https://m") to 1), q)
    }

    @Test fun mediaRoundTrip() {
        val data = Bytes.random(1000)
        val enc = Media.encrypt("intro", data, "audio/ogg", 3.0, listOf("https://blossom.band/x"))
        enc.descriptor.validate()
        assertTrue(Media.decrypt(enc.descriptor, enc.ciphertext).contentEquals(data))
        assertThrows(IllegalArgumentException::class.java) { Media.decrypt(enc.descriptor.copy(size = 1), enc.ciphertext) }
        val fresh = Media.freshCopy(enc.descriptor, enc.ciphertext)
        assertTrue(fresh.descriptor.x != enc.descriptor.x)
        assertEquals(enc.descriptor.ox, fresh.descriptor.ox)
    }
}
