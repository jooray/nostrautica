package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.ChatKeyAttestationContent
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterChatKey
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.Wire

class AttestTest {
    private val accountSk = Secp.generateSecret()
    private val account = Secp.pubkeyHex(accountSk)
    private val deviceSk = Secp.generateSecret()
    private val device = Secp.pubkeyHex(deviceSk)
    private val coordinate = "31923:${"e".repeat(64)}:conf"

    @Test fun addCarriesAProofOverTheRumorTimestamp() {
        val at = 1_760_000_000L
        val c = ChatAttest.content(coordinate, account, ChatAttest.Op.ADD, device, at, "Android (Pixel)", "android-1", deviceSk)
        assertEquals("add", c.op)
        assertTrue(ProtocolCrypto.verifyChatDeviceProof(c.proof!!, coordinate, account, device, at))
        // A proof is bound to its created_at: the coordinator rejects any other.
        assertFalse(ProtocolCrypto.verifyChatDeviceProof(c.proof!!, coordinate, account, device, at + 1))
        // ...and to the account that seals it.
        assertFalse(ProtocolCrypto.verifyChatDeviceProof(c.proof!!, coordinate, device, device, at))
    }

    @Test fun addWithoutTheDeviceSecretIsRefused() {
        assertThrows { ChatAttest.content(coordinate, account, ChatAttest.Op.ADD, device, 1, "x") }
    }

    @Test fun addNeedsALabel() {
        assertThrows { ChatAttest.content(coordinate, account, ChatAttest.Op.ADD, device, 1, "  ", deviceSecret = deviceSk) }
    }

    @Test fun revokeAndLinkCarryNoProof() {
        val r = ChatAttest.content(coordinate, account, ChatAttest.Op.REVOKE, device, 1)
        assertNull(r.proof)
        val l = ChatAttest.content(coordinate, account, ChatAttest.Op.LINK, device, 1, label = "White Noise")
        assertNull(l.proof)
        assertThrows { ChatAttest.content(coordinate, account, ChatAttest.Op.LINK, device, 1) } // label required
        val k = ChatAttest.content(coordinate, account, ChatAttest.Op.LINK_CONFIRM, device, 1, code = "ABCD-2345")
        assertEquals("ABCD-2345", k.code)
        assertThrows { ChatAttest.content(coordinate, account, ChatAttest.Op.LINK_CONFIRM, device, 1) } // code required
    }

    @Test fun jsonIsTheWireShapeAndRoundTrips() {
        val c = ChatAttest.content(coordinate, account, ChatAttest.Op.ADD, device, 5, "Phone", "android-x", deviceSk)
        val json = ChatAttest.json(c)
        assertTrue(json.contains("\"chat_pubkey\":\"$device\""))
        assertTrue(json.contains("\"client_id\":\"android-x\""))
        assertTrue(json.contains("\"v\":2"))
        assertFalse("nulls are omitted", json.contains("null"))
        val back = (Wire.parseSafe(ChatKeyAttestationContent.serializer(), json) as Wire.Result.Ok).value
        assertEquals(c, back)
    }

    @Test fun overlongLabelIsTrimmedToTheWireLimit() {
        val c = ChatAttest.content(coordinate, account, ChatAttest.Op.ADD, device, 5, "x".repeat(80), deviceSecret = deviceSk)
        assertEquals(60, c.label!!.length)
    }

    @Test fun linkCodesNormalizeLikeTheCoordinator() {
        assertEquals("ABCD2345", ChatKeyAttestationContent.normalizeLinkCode(" abcd-23.45 "))
    }
}

class GroupBindingTest {
    private val coord = "c".repeat(64)
    private val me = "d".repeat(64)
    private val gid = "a1".repeat(32)
    private fun g(
        nostrId: String = gid, welcomer: String? = coord, members: List<String>? = listOf(coord, me),
        self: Boolean = true, pending: Boolean = false, id: String = "mls-" + nostrId.take(4),
    ) = GroupBinding.GroupInfo(id, nostrId, welcomer, members, self, pending)

    @Test fun noRosterIdFailsClosed() {
        assertEquals(GroupBinding.Result.Unverified, GroupBinding.select(listOf(g()), null, coord))
        assertEquals(GroupBinding.Phase.SETUP, GroupBinding.phase(GroupBinding.select(listOf(g()), null, coord)))
    }

    @Test fun bindsOnlyTheRosterNamedGroup() {
        val other = g(nostrId = "b2".repeat(32))
        val r = GroupBinding.select(listOf(other, g()), gid, coord)
        assertEquals(gid, (r as GroupBinding.Result.Bound).group.nostrGroupIdHex)
        assertEquals(GroupBinding.Result.NotJoined, GroupBinding.select(listOf(other), gid, coord))
    }

    @Test fun matchesTheIdCaseInsensitively() {
        assertTrue(GroupBinding.select(listOf(g()), gid.uppercase(), coord) is GroupBinding.Result.Bound)
    }

    @Test fun refusesAGroupSealedBySomeoneElseOrWithoutTheCoordinator() {
        assertEquals(GroupBinding.Result.NotJoined, GroupBinding.select(listOf(g(welcomer = "f".repeat(64))), gid, coord))
        assertEquals(GroupBinding.Result.NotJoined, GroupBinding.select(listOf(g(members = listOf(me))), gid, coord))
        // An unknown welcomer / unreadable member list is not evidence against it.
        assertTrue(GroupBinding.select(listOf(g(welcomer = null, members = null)), gid, coord) is GroupBinding.Result.Bound)
    }

    @Test fun removedMemberIsEvictedNotReady() {
        val r = GroupBinding.select(listOf(g(self = false, members = listOf(coord))), gid, coord)
        assertEquals(GroupBinding.Phase.EVICTED, GroupBinding.phase(r))
    }

    @Test fun prefersTheLiveStateAfterARejoin() {
        val dead = g(self = false, id = "dead")
        val live = g(self = true, id = "live")
        val r = GroupBinding.select(listOf(dead, live), gid, coord) as GroupBinding.Result.Bound
        assertEquals("live", r.group.groupIdHex)
        assertEquals(GroupBinding.Phase.READY, GroupBinding.phase(r))
    }

    @Test fun acceptsOnlyInvitationsFromTheCoordinator() {
        val mine = g(pending = true)
        val stranger = g(pending = true, welcomer = "f".repeat(64), id = "x")
        val accepted = g(pending = false, id = "y")
        assertEquals(listOf(mine), GroupBinding.acceptable(listOf(mine, stranger, accepted), coord))
        assertTrue(GroupBinding.acceptable(listOf(mine), null).isEmpty())
    }
}

class ChatMembersTest {
    private val alice = "a".repeat(64)
    private val bob = "b".repeat(64)
    private val coord = "c".repeat(64)
    private val a1 = "1".repeat(64)
    private val a2 = "2".repeat(64)
    private val b1 = "3".repeat(64)
    private val wn = "4".repeat(64)
    private val roster = RosterContent(
        v = 2, eckCurrent = 1, nostrGroupId = "ab".repeat(32),
        attendees = listOf(
            RosterAttendee(bob, "db", "attendee", listOf(RosterChatKey(b1, "Bob phone", 1_700_000_000))),
            RosterAttendee(alice, "da", "organizer", listOf(RosterChatKey(a1, "Laptop", 10), RosterChatKey(a2, null, 20), RosterChatKey(wn, "White Noise", 30, external = true))),
        ),
    )

    @Test fun mapsDevicesToTheirAccount() {
        val m = ChatMembers.deviceAccountMap(roster)
        assertEquals(alice, ChatMembers.accountOf(a2, m))
        assertEquals(bob, ChatMembers.accountOf(bob, m))
        assertEquals("9".repeat(64), ChatMembers.accountOf("9".repeat(64), m))
    }

    @Test fun rosterOnlyListIsLabelledAttested() {
        val l = ChatMembers.list(roster, null)
        assertEquals(ChatMembers.Source.ATTESTED, l.source)
        assertEquals(listOf(alice, bob), l.members.map { it.account }) // organizers first
        assertEquals(3, l.members[0].deviceCount)
    }

    @Test fun groupMembershipFiltersAndKeepsUnrosteredDevices() {
        val stranger = "5".repeat(64)
        val l = ChatMembers.list(roster, listOf(a1, coord, stranger), exclude = listOf(coord))
        assertEquals(ChatMembers.Source.GROUP, l.source)
        val accounts = l.members.map { it.account }
        assertEquals(listOf(alice, stranger), accounts) // bob attested but not in the room; coordinator hidden
        assertEquals(1, l.members[0].deviceCount)
    }

    @Test fun devicesForAnAccountKeepTheExternalFlag() {
        val d = ChatMembers.devicesFor(roster, alice)
        assertEquals(3, d.size)
        assertTrue(d.single { it.pubkey == wn }.external)
        assertTrue(ChatMembers.devicesFor(roster, coord).isEmpty())
    }

    @Test fun addedAtAcceptsSecondsAndLegacyMillis() {
        assertEquals(1_700_000_000_000L, ChatMembers.addedAtMillis(1_700_000_000))
        assertEquals(1_700_000_000_000L, ChatMembers.addedAtMillis(1_700_000_000_000))
    }

    @Test fun profilePubkeysCoverAccountsAndDevices() {
        val (accounts, devices) = ChatMembers.profilePubkeys(roster)
        assertEquals(setOf(alice, bob), accounts.toSet())
        assertEquals(setOf(a1, a2, b1, wn), devices.toSet())
    }

    @Test fun cleansLegacyDeviceNames() {
        assertEquals("Juraj", ChatMembers.cleanName("Nostrautica Juraj (chat)"))
        assertEquals("Juraj", ChatMembers.cleanName("Juraj"))
    }
}

class DmCommandTest {
    private val juraj = DmCommand.Target("a".repeat(64), "Juraj")
    private val jurajB = DmCommand.Target("b".repeat(64), "Juraj Bednár")
    private val stallion = DmCommand.Target("c".repeat(64), "stallion")
    private val room = listOf(juraj, jurajB, stallion)

    @Test fun leavesOrdinaryMessagesAlone() {
        for (d in listOf("hello world", "", "/msgpack is a format", "/mention me", "not /msg stallion hi")) assertNull(d, DmCommand.parse(d, room))
    }

    @Test fun bareCommandOpensThePicker() {
        for (d in listOf("/m", "/msg", "/m ", "/msg ", "/MSG ")) assertEquals(d, DmCommand.Parsed.Choosing(""), DmCommand.parse(d, room))
        assertEquals(DmCommand.Parsed.Choosing("stal"), DmCommand.parse("/msg stal", room))
    }

    @Test fun settlesAndTakesTheRest() {
        assertEquals(DmCommand.Parsed.Ready(stallion, "ahoj"), DmCommand.parse("/msg stallion ahoj", room))
        assertEquals(DmCommand.Parsed.Ready(stallion, ""), DmCommand.parse("/msg stallion ", room))
        assertEquals(DmCommand.Parsed.Ready(stallion, ""), DmCommand.parse("/msg stallion", room))
        assertEquals(DmCommand.Parsed.Ready(stallion, "hi"), DmCommand.parse("/msg STALLION hi", room))
        assertEquals(DmCommand.Parsed.Ready(stallion, "first\nsecond"), DmCommand.parse("/msg stallion first\nsecond", room))
    }

    @Test fun shortNameDoesNotSwallowALongerOne() {
        assertEquals(DmCommand.Parsed.Choosing("Juraj"), DmCommand.parse("/msg Juraj", room))
        assertEquals(DmCommand.Parsed.Ready(juraj, "hi"), DmCommand.parse("/msg Juraj hi", room))
        assertEquals(DmCommand.Parsed.Ready(jurajB, "hi"), DmCommand.parse("/msg Juraj Bednár hi", room))
    }

    @Test fun noMatchStaysInThePicker() {
        assertEquals(DmCommand.Parsed.Choosing("nobody at all"), DmCommand.parse("/msg nobody at all", room))
    }

    @Test fun matchingOrdersPrefixFirst() {
        assertEquals(room, DmCommand.match(room, ""))
        assertEquals(listOf(stallion), DmCommand.match(listOf(stallion, juraj), "al"))
        val alma = DmCommand.Target("d".repeat(64), "Alma")
        assertEquals(listOf("Alma", "stallion"), DmCommand.match(listOf(alma, stallion), "al").map { it.name })
        assertEquals(listOf("Juraj", "Juraj Bednár"), DmCommand.match(room, "JUR").map { it.name })
        assertEquals(2, DmCommand.match(room, "", 2).size)
    }
}

class ExternalLinkTest {
    private val pk = Secp.pubkeyHex(Secp.generateSecret())
    private val a = "31923:${"e".repeat(64)}:x"
    private fun n(stage: String, at: Long, state: String = "poison", cat: String? = null) =
        CoordinatorStatusContent(a = a, stage = stage, state = state, errorCategory = cat, at = at)

    @Test fun parsesNpubNprofileAndHexButNeverAnNsec() {
        assertEquals(pk, ExternalLink.parsePubkey(Nip19.npub(pk)))
        assertEquals(pk, ExternalLink.parsePubkey("nostr:" + Nip19.npub(pk)))
        assertEquals(pk, ExternalLink.parsePubkey(pk.uppercase()))
        assertEquals(pk, ExternalLink.parsePubkey(Nip19.nprofile(Nip19.Profile(pk, listOf("wss://r.example")))))
        assertNull(ExternalLink.parsePubkey(Nip19.nsec(Secp.generateSecret())))
        assertNull(ExternalLink.parsePubkey("hello"))
    }

    @Test fun latestNoticeIgnoresEarlierAttempts() {
        val old = n("chat_link", 1_000, cat = "chat_link_code_wrong")
        val fresh = n("chat_link", 2_000, cat = "chat_link_expired")
        val other = n("chat_attestation", 3_000)
        assertEquals(fresh, ExternalLink.latestNotice(listOf(old, fresh, other), sinceSec = 1_990))
        // Anything at or before what was on hand when the user acted belongs to that earlier action.
        assertNull(ExternalLink.latestNotice(listOf(old, fresh), sinceSec = 1_990, afterAt = 2_000))
        assertNull(ExternalLink.latestNotice(listOf(old), sinceSec = 5_000))
        assertEquals(2_000, ExternalLink.newestNoticeAt(listOf(old, fresh, other)))
    }

    @Test fun refusalsMapToStringsAndOnlyAWrongCodeKeepsTheLink() {
        assertEquals("chat.wn.refused.codeWrong", ExternalLink.refusalKey("chat_link_code_wrong"))
        assertEquals("chat.wn.refused.other", ExternalLink.refusalKey("something_new"))
        assertFalse(ExternalLink.refusalEndsLink("chat_link_code_wrong"))
        assertTrue(ExternalLink.refusalEndsLink("chat_link_expired"))
    }

    @Test fun setupRefusalReadsTheNewestPoisonAttestationNotice() {
        assertNull(ExternalLink.setupRefusalKey(listOf(n("chat_attestation", 5, state = "cleared"))))
        assertEquals("chat.refused.deviceCap", ExternalLink.setupRefusalKey(listOf(n("chat_attestation", 5, cat = "chat_device_cap_reached"))))
        assertEquals("chat.refused.other", ExternalLink.setupRefusalKey(listOf(n("chat_attestation", 5, cat = "novel"))))
    }
}

class ChatDeviceKeysTest {
    private class MemKv : SecretKv {
        val m = HashMap<String, String>()
        override fun get(name: String) = m[name]
        override fun put(name: String, value: String?) { if (value == null) m.remove(name) else m[name] = value }
    }

    @Test fun mintsOncePerAccountAndNeverTheAccountKey() {
        val kv = MemKv()
        val keys = ChatDeviceKeys(kv)
        val account = "a".repeat(64)
        val d1 = keys.ensure(account)
        val d2 = keys.ensure(account)
        assertEquals(d1.pubkey, d2.pubkey)
        assertEquals(d1.clientId, d2.clientId)
        assertTrue(d1.clientId.startsWith("android-"))
        assertNotEquals(account, d1.pubkey)
        assertEquals(d1.pubkey, keys.peekPubkey(account))
        assertNotEquals(d1.pubkey, keys.ensure("b".repeat(64)).pubkey)
        assertEquals(d1.pubkey, Secp.pubkeyHex(Bytes.fromHex(d1.secretHex)))
    }

    @Test fun labelsAndRelaysPersist() {
        val keys = ChatDeviceKeys(MemKv())
        keys.saveLabel("p", "  Work phone ")
        assertEquals("Work phone", keys.label("p"))
        keys.saveLabel("p", "   ")
        assertEquals("Work phone", keys.label("p"))
        keys.saveAdvertisedRelays("p", listOf("wss://a", "wss://b"))
        assertEquals(listOf("wss://a", "wss://b"), keys.advertisedRelays("p"))
    }

    @Test fun mergedRelaysKeepTheCurrentEventFirstAndAreCapped() {
        val prev = (1..30).map { "wss://old$it" }
        val cur = listOf("wss://new1", "wss://old1")
        val merged = ChatDeviceKeys.mergeRelays(prev, cur)
        assertEquals(ChatDeviceKeys.MAX_ADVERTISED_RELAYS, merged.size)
        assertEquals(listOf("wss://new1", "wss://old1"), merged.take(2))
        assertEquals(merged.distinct(), merged)
    }

    @Test fun pendingLinkExpiresWithTheCode() {
        val keys = ChatDeviceKeys(MemKv())
        val w = "f".repeat(64)
        keys.savePendingLink("a", "c", ChatDeviceKeys.PendingLink(w, 1_000))
        assertNotNull(keys.pendingLink("a", "c", nowMs = 1_000_000 + 60_000))
        assertNull(keys.pendingLink("a", "c", nowMs = 1_000_000 + 31 * 60_000))
        keys.savePendingLink("a", "c", null)
        assertNull(keys.pendingLink("a", "c", nowMs = 1_000_000))
    }
}

private fun assertThrows(block: () -> Unit) {
    val threw = runCatching(block).isFailure
    assertTrue("expected an exception", threw)
}
