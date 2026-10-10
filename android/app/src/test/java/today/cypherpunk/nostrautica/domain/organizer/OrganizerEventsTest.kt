package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.EventKeysBackup
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.KeyGrantContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.OrganizerGrantContent
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.jsonObjectOf

class OrganizerEventsTest {
    private val eidSk = Secp.generateSecret()
    private val inboxSk = Secp.generateSecret()
    private val eck = Bytes.random(32)

    private fun create(input: CreateEventInput) = OrganizerEvents.buildCreate(input, eidSk, inboxSk, eck, d = "meetup-0a0b0c0d", now = 1_800_000_000)

    @Test fun createdConfigParsesBackWithEveryField() {
        val c = create(CreateEventInput(
            title = "Meetup", summary = "s", start = 1_800_000_000, end = 1_800_007_200, maxVideoSec = 0, maxTalkSec = 600,
            matching = false, approval = "invite", lang = "sk", talks = "prerecord-first", chat = listOf("marmot"),
            relays = listOf("wss://relay.one", "wss://relay.two"),
        ))
        assertTrue(c.configEvent.verify())
        assertEquals(Kinds.EVENT_CONFIG, c.configEvent.kind)
        val parsed = EventConfig.parse(c.configEvent)
        assertEquals(c.config, parsed)
        assertEquals("meetup-0a0b0c0d", parsed.d)
        assertEquals(Secp.pubkeyHex(inboxSk), parsed.inbox)
        assertEquals(0, parsed.maxVideoSec)
        assertEquals(600, parsed.maxTalkSec)
        assertEquals("sk", parsed.lang)
        assertEquals("prerecord-first", parsed.talks)
        assertTrue(parsed.isMarmotChatEnabled.not()) // no coordinator yet
        assertEquals(listOf("marmot"), parsed.chat)
        // Chat interop relays are a separate set, never in `relay`.
        assertEquals(listOf("wss://relay.one", "wss://relay.two"), parsed.relays)
        assertEquals(EventConfig.CHAT_INTEROP_RELAYS, parsed.chatRelays)
        assertNull(parsed.coordinator)
    }

    @Test fun createSignsEverythingWithEidAndBacksUpTheKeys() {
        val c = create(CreateEventInput(title = "Meetup", summary = "About", start = 1_800_000_000, icon = "https://x/i.png", banner = "https://x/b.png", location = "Bratislava"))
        val eid = Secp.pubkeyHex(eidSk)
        listOf(c.kind0, c.space, c.configEvent).forEach { assertTrue(it.verify()); assertEquals(eid, it.pubkey) }
        assertEquals(Kinds.CALENDAR_EVENT, c.space.kind)
        assertEquals("${Kinds.CALENDAR_EVENT}:$eid:meetup-0a0b0c0d", c.coordinate)
        assertEquals(Coordinate.parse(c.coordinate), Coordinate.fromNaddr(c.naddr).first)
        assertEquals("https://x/b.png", c.space.tag("image"))
        assertEquals("Bratislava", c.space.tag("location"))
        val k0 = jsonObjectOf(c.kind0.content)!!
        assertEquals("\"Meetup\"", k0["name"].toString())
        assertEquals("\"https://x/i.png\"", k0["picture"].toString())
        // Defaults when no relays were given.
        assertEquals(today.cypherpunk.nostrautica.nostr.Relays.DEFAULT, c.config.relays)
        assertTrue(c.config.chatRelays.isEmpty())
        // The backup round-trips and names the coordinate.
        val b = Wire.parse(EventKeysBackup.serializer(), Wire.encode(EventKeysBackup.serializer(), c.backup))
        assertEquals(c.coordinate, b.a)
        assertEquals(Bytes.toHex(eidSk), b.eidNsec)
        assertEquals(Bytes.toHex(inboxSk), b.einboxNsec)
        assertEquals(listOf(1), b.eck.map { it.id })
        assertNull(b.coordinatorGen)
    }

    @Test fun communityIs31612WithNoTimeOrPlace() {
        val c = create(CreateEventInput(title = "Club", summary = "", community = true, approval = "open", location = "ignored"))
        assertEquals(Kinds.COMMUNITY, c.space.kind)
        assertTrue(c.coordinate.startsWith("${Kinds.COMMUNITY}:"))
        assertNull(c.space.tag("start"))
        assertTrue(c.space.tags.none { it[0] == "D" })
        assertEquals("open", EventConfig.parse(c.configEvent).approval)
    }

    @Test fun dayIndexTagsAreHalfOpenAndCapped() {
        val day = 20_000L * 86400
        assertEquals(listOf(listOf("D", "20000")), OrganizerEvents.dayIndexTags(day + 3600, null))
        // Ends exactly at midnight: the next day is not tagged.
        assertEquals(listOf("20000"), OrganizerEvents.dayIndexTags(day + 3600, day + 86400).map { it[1] })
        assertEquals(listOf("20000", "20001"), OrganizerEvents.dayIndexTags(day + 3600, day + 86401).map { it[1] })
        assertEquals(OrganizerEvents.MAX_DAY_TAGS, OrganizerEvents.dayIndexTags(day, day + 400L * 86400).size)
        assertEquals(1, OrganizerEvents.dayIndexTags(day, day - 5).size)
    }

    @Test fun slugIsAsciiPlusRandomHex() {
        assertEquals("cypherpunk-assembly-2026-01020304", OrganizerEvents.slug("Cypherpunk Assembly 2026!", byteArrayOf(1, 2, 3, 4)))
        assertEquals("event-01020304", OrganizerEvents.slug("Ľščť", byteArrayOf(1, 2, 3, 4)))
    }

    // ── Roster rewrite safety ────────────────────────────────────────────────

    @Test fun rosterRewriteRefusesALostRead() {
        val read: List<OrganizerEvents.RosterRead> = listOf(OrganizerEvents.RosterRead.Absent(suspect = true), OrganizerEvents.RosterRead.Unreadable(5))
        for (r in read) {
            try { OrganizerEvents.rosterForRewrite(r, 1); fail("must refuse $r") } catch (_: OrganizerEvents.RosterUnreadable) {}
        }
        val (empty, at) = OrganizerEvents.rosterForRewrite(OrganizerEvents.RosterRead.Absent(suspect = false), 3)
        assertTrue(empty.attendees.isEmpty()); assertEquals(3, empty.eckCurrent); assertEquals(0L, at)
    }

    @Test fun rosterEventsAreNewerThanTheirBaseAndSkipUnchangedPages() {
        val coord = "31923:${Secp.pubkeyHex(eidSk)}:d1"
        val r = RosterContent(2, 1, null, null, listOf(RosterAttendee("a".repeat(64), "x", "attendee")))
        val evs = OrganizerEvents.buildRosterEvents(coord, eidSk, eck, 1, r, baseCreatedAt = 2_000_000_000, now = 1_900_000_000)
        assertEquals(1, evs.size)
        assertEquals(2_000_000_001, evs[0].createdAt)
        assertEquals("d1", evs[0].d)
        assertEquals(coord, evs[0].tag("a"))
        assertTrue(evs[0].verify())
        val back = Wire.parse(RosterContent.serializer(), Nip44.eckDecrypt(eck, evs[0].content))
        assertEquals(r.attendees, back.attendees)
        // Same roster as what's on the relay → nothing to republish.
        assertTrue(OrganizerEvents.buildRosterEvents(coord, eidSk, eck, 1, r, previous = r).isEmpty())
    }

    @Test fun eckRotationMintsNextVersionAndRederivesEveryD() {
        val prev = listOf(today.cypherpunk.nostrautica.protocol.EckVersion(1, Bytes.toBase64(eck)), today.cypherpunk.nostrautica.protocol.EckVersion(3, Bytes.toBase64(eck)))
        val next = OrganizerEvents.nextEck(prev)
        assertEquals(4, next.id)
        assertEquals(32, next.bytes().size)
        val coord = "31923:${Secp.pubkeyHex(eidSk)}:d1"
        val a = RosterAttendee("b".repeat(64), ProtocolCrypto.blindedD(eck, coord, "b".repeat(64)), "organizer")
        val re = OrganizerEvents.rederive(coord, listOf(a), next.bytes()).single()
        assertNotEquals(a.d, re.d)
        assertEquals(ProtocolCrypto.blindedD(next.bytes(), coord, a.pubkey), re.d)
        assertEquals("organizer", re.role)
    }

    // ── Grants sealed by E_id ────────────────────────────────────────────────

    @Test fun keyGrantIsSealedByEidAndParses() = runBlocking {
        val attendeeSk = Secp.generateSecret()
        val eid = LocalSigner(eidSk)
        val coord = "31923:${eid.pubkey}:d1"
        val content = Wire.encode(KeyGrantContent.serializer(), KeyGrantContent(a = coord, role = "attendee", eck = listOf(today.cypherpunk.nostrautica.protocol.EckVersion(1, Bytes.toBase64(eck))), grantedBy = eid.pubkey))
        val wrap = GiftWrap.wrap(eid, Secp.pubkeyHex(attendeeSk), GiftWrap.rumor(eid.pubkey, Kinds.KEY_GRANT, content))
        assertNotEquals(eid.pubkey, wrap.pubkey) // one-time wrap key
        val rumor = GiftWrap.unwrapLocal(wrap, attendeeSk, Kinds.ATTENDEE_RUMOR_KINDS)
        assertEquals(eid.pubkey, rumor.pubkey)
        val g = Wire.parse(KeyGrantContent.serializer(), rumor.content)
        assertEquals(coord, g.a)
        assertEquals(eid.pubkey, g.grantedBy)
        assertEquals(1, g.eck.single().id)
    }

    @Test fun organizerGrantCarriesSecretsMatchingTheConfig() = runBlocking {
        val eid = LocalSigner(eidSk)
        val coord = "31923:${eid.pubkey}:d1"
        val g = OrganizerGrantContent(a = coord, eidNsec = Bytes.toHex(eidSk), einboxNsec = Bytes.toHex(inboxSk), eck = emptyList(), configRelays = listOf("wss://r"), grantedBy = eid.pubkey)
        val parsed = Wire.parse(OrganizerGrantContent.serializer(), Wire.encode(OrganizerGrantContent.serializer(), g))
        assertEquals(Secp.pubkeyHex(Bytes.fromHex(parsed.eidNsec)), Coordinate.parse(parsed.a).pubkey)
        assertEquals(Secp.pubkeyHex(inboxSk), Secp.pubkeyHex(Bytes.fromHex(parsed.einboxNsec)))
    }

    @Test fun chatInteropRelaysSkipLocalOnlyEventsAndRelayUrlsAreChecked() {
        assertTrue(OrganizerEvents.chatInteropRelays(listOf("ws://localhost:7777")).isEmpty())
        assertEquals(EventConfig.CHAT_INTEROP_RELAYS, OrganizerEvents.chatInteropRelays(listOf("wss://nos.lol")))
        assertTrue(OrganizerEvents.isAcceptedRelayUrl("wss://nos.lol"))
        assertTrue(OrganizerEvents.isAcceptedRelayUrl("ws://localhost:7777"))
        assertFalse(OrganizerEvents.isAcceptedRelayUrl("ws://evil.example"))
        assertFalse(OrganizerEvents.isAcceptedRelayUrl("https://nos.lol"))
        assertEquals(listOf("wss://a", "wss://b"), OrganizerEvents.unionRelays(listOf("wss://a/", " wss://b"), listOf("wss://a")))
    }
}
