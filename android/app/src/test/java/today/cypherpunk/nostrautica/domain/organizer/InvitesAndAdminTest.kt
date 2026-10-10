package today.cypherpunk.nostrautica.domain.organizer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.InviteEntry
import today.cypherpunk.nostrautica.protocol.InviteListContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.Wire

class InvitesAndAdminTest {
    private val coord = "31923:${"e".repeat(64)}:d1"
    private val base = "https://nostrautica.cypherpunk.today/app/#/e/naddr1x/join"

    @Test fun mintedBatchMergesLabelsAndPublishesOnlyHashes() {
        val existing = listOf(InviteEntry("0".repeat(64), "invite-1"), InviteEntry("1".repeat(64), "invite-2"))
        val b = Invites.mint(existing, 3, base, "sk")
        assertEquals(listOf("invite-3", "invite-4", "invite-5"), b.generated.map { it.label })
        assertEquals(5, b.list.size)
        for ((inv, entry) in b.generated.zip(b.list.drop(2))) {
            assertEquals(ProtocolCrypto.inviteHash(inv.pubkey!!), entry.h)
            // Single-use default publishes byte-identical entries: no uses/exp.
            assertNull(entry.uses); assertNull(entry.exp)
            assertTrue(inv.link.startsWith("$base?code=nsec1"))
            assertTrue(inv.link.endsWith("&lang=sk"))
            assertFalse(entry.h in inv.link)
        }
        // The list validates as a 31601 payload.
        Wire.parse(InviteListContent.serializer(), Wire.encode(InviteListContent.serializer(), InviteListContent(invites = b.list)))
        // English events keep the old link shape.
        assertFalse(Invites.mint(emptyList(), 1, base, "en").generated.single().link.contains("lang="))
    }

    @Test fun sharedCodeCarriesUsesAndExpiry() {
        val b = Invites.mint(emptyList(), 1, base, null, "door", uses = 0, exp = 1_900_000_000)
        assertEquals("door-1", b.generated.single().label)
        assertEquals(0, b.list.single().uses)
        assertEquals(1_900_000_000L, b.list.single().exp)
    }

    @Test fun zeroHoursMeansNoExpiryNotOneHour() {
        assertNull(Invites.sharedInviteExp(0.0, 1_000_000))
        assertNull(Invites.sharedInviteExp(null, 1_000_000))
        assertNull(Invites.sharedInviteExp(-2.0, 1_000_000))
        assertEquals(1_000L + 4 * 3600, Invites.sharedInviteExp(4.0, 1_000_000))
    }

    @Test fun inviteProofValidatesOnlyForPublishedHashAndTheRightAttendee() {
        val sk = Secp.generateSecret()
        val attendee = Secp.pubkeyHex(Secp.generateSecret())
        val p = ProtocolCrypto.makeInviteProof(sk, coord, attendee)
        val ref = InviteProofRef(p.invitePubkey, p.sig)
        val published = setOf(ProtocolCrypto.inviteHash(p.invitePubkey))
        assertTrue(Invites.isInviteValid(ref, published, coord, attendee))
        assertFalse(Invites.isInviteValid(ref, emptySet(), coord, attendee))
        assertFalse(Invites.isInviteValid(ref, published, coord, "a".repeat(64)))
    }

    @Test fun csvEscapesQuotesNewlinesAndFormulas() {
        assertEquals("plain", Invites.csvCell("plain"))
        assertEquals("\"a,b\"", Invites.csvCell("a,b"))
        assertEquals("\"say \"\"hi\"\"\"", Invites.csvCell("say \"hi\""))
        assertEquals("'=SUM(A1)", Invites.csvCell("=SUM(A1)"))
        assertEquals("\"'-1,2\"", Invites.csvCell("-1,2"))
        val inv = GeneratedInvite("invite-1", "nsec1abc", "$base?code=nsec1abc")
        assertEquals("label,code,link\r\ninvite-1,nsec1abc,$base?code=nsec1abc\r\n", Invites.codesCsv(listOf(inv)))
        assertEquals("$base?code=nsec1abc", Invites.codesTxt(listOf(inv)))
        assertEquals('﻿', Invites.CSV_BOM.single())
        assertEquals("nostrautica-codes-naddr1qqxnzd.csv", Invites.exportFilename("codes", "naddr1qqxnzd3exxxx", "csv"))
    }

    @Test fun usageReportIsEarliestRedemptionAndUnionOnly() {
        val sk = Secp.generateSecret()
        val pub = Secp.pubkeyHex(sk)
        val h = ProtocolCrypto.inviteHash(pub)
        val a1 = Secp.pubkeyHex(Secp.generateSecret())
        val a2 = Secp.pubkeyHex(Secp.generateSecret())
        fun req(pk: String, at: Long) = ProtocolCrypto.makeInviteProof(sk, coord, pk).let { PendingRequest(pk, "N$at", invite = InviteProofRef(it.invitePubkey, it.sig), rumorCreatedAt = at) }
        val used = Invites.observeUsed(listOf(req(a2, 20), req(a1, 10)), setOf(h), coord)
        assertEquals(a1, used[h]!!.pubkey)
        val merged = Invites.mergeUsage(used, emptyMap())
        assertEquals(used, merged)
        val rows = Invites.buildUsageRows(listOf(Invites.Issued(h, "invite-1"), Invites.Issued("f".repeat(64), "invite-2")), merged) { if (it == a1) "Alice" else null }
        assertEquals(1, Invites.usedCount(rows))
        assertEquals(Nip19.npub(a1), rows[0].npub)
        assertEquals("Alice", rows[0].displayName)
        assertEquals(listOf("invite-2"), Invites.filterUsageRows(rows, unusedOnly = true).map { it.label })
        val csv = Invites.usageCsv(rows)
        assertTrue(csv.startsWith("label,used,used_at,npub,display_name\r\ninvite-1,yes,1970-01-01T00:00:10.000Z,"))
        assertTrue(csv.endsWith("invite-2,no,,,\r\n"))
    }

    @Test fun sheetDropsRedeemedSingleUseCodesOnly() {
        val s1 = Secp.generateSecret(); val s2 = Secp.generateSecret()
        val single = GeneratedInvite("invite-1", Nip19.nsec(s1), "l1")
        val shared = GeneratedInvite("door-1", Nip19.nsec(s2), "l2", uses = 0)
        val used = mapOf(
            ProtocolCrypto.inviteHash(Secp.pubkeyHex(s1)) to Invites.Used(1, "a".repeat(64)),
            ProtocolCrypto.inviteHash(Secp.pubkeyHex(s2)) to Invites.Used(1, "b".repeat(64)),
        )
        assertEquals(listOf("door-1"), Invites.forSheet(listOf(single, shared), used).map { it.label })
    }

    // ── E_inbox fold ─────────────────────────────────────────────────────────

    private fun rumor(pk: String, kind: Int, content: String, at: Long, tags: List<List<String>> = emptyList()): Rumor {
        val u = UnsignedEvent(pk, at, kind, tags, content)
        return Rumor(u.id, pk, at, kind, tags, content)
    }

    @Test fun inboxFoldsLatestJoinRevisionAndWithdrawal() {
        val a = "a".repeat(64); val b = "b".repeat(64); val c = "c".repeat(64)
        val rumors = listOf(
            rumor(a, Kinds.JOIN_REQUEST, """{"v":2,"name":"Old","message":"","rsvp_public":false}""", 10),
            rumor(a, Kinds.JOIN_REQUEST, """{"v":2,"name":"New","message":"hi","rsvp_public":true}""", 20, listOf(listOf("invite", "1".repeat(64), "2".repeat(128)))),
            rumor(a, Kinds.PROFILE_SUBMISSION, """{"v":2,"rev":2,"profile":{"about":"rev2"}}""", 15),
            rumor(a, Kinds.PROFILE_SUBMISSION, """{"v":2,"rev":1,"profile":{"about":"rev1"}}""", 30),
            rumor(b, Kinds.JOIN_REQUEST, """{"v":2,"name":"B","message":"","rsvp_public":false}""", 5),
            rumor(b, Kinds.ATTENDEE_WITHDRAWAL, """{"v":2,"a":"$coord","delete_data":true}""", 6),
            rumor(c, Kinds.ATTENDEE_WITHDRAWAL, """{"v":2,"a":"$coord","delete_data":false}""", 7),
            rumor(c, Kinds.ATTENDEE_WITHDRAWAL, """{"v":2,"a":"31923:${"f".repeat(64)}:other","delete_data":true}""", 8),
            rumor(a, Kinds.JOIN_REQUEST, "not json", 99),
        )
        val out = InboxFold.fold(rumors, coord).associateBy { it.attendeePubkey }
        assertEquals("New", out[a]!!.name)
        assertEquals("rev2", out[a]!!.profile!!.about) // a delayed rev 1 never replaces rev 2
        assertEquals("1".repeat(64), out[a]!!.invite!!.invitePubkey)
        assertTrue(out[b]!!.withdrawn && out[b]!!.withdrawalRequestedPurge)
        assertTrue(out[c]!!.withdrawn && !out[c]!!.withdrawalRequestedPurge && out[c]!!.name.isEmpty())
        assertFalse(out[a]!!.withdrawn)
    }

    @Test fun pendingTalksSkipAlreadyPublishedRevisions() {
        val s = "a".repeat(64)
        fun talk(rev: Int, at: Long) = rumor(s, Kinds.TALK_SUBMISSION, """{"v":2,"a":"$coord","talk_d":"t1","title":"T$rev","external_url":"https://youtu.be/x","external_kind":"youtube","revision":$rev}""", at)
        assertEquals(listOf("T2"), InboxFold.pendingTalks(listOf(talk(1, 1), talk(2, 2)), coord, emptyMap()).map { it.title })
        assertTrue(InboxFold.pendingTalks(listOf(talk(2, 2)), coord, mapOf("$s:t1" to 2L)).isEmpty())
    }

    // ── Admin model ──────────────────────────────────────────────────────────

    @Test fun mergeNeverDropsAKnownRequestAndApprovedPeopleComeFromTheRoster() {
        val a = "a".repeat(64); val b = "b".repeat(64); val o = "0".repeat(64)
        val known = listOf(PendingRequest(a, "A", rumorCreatedAt = 1), PendingRequest(b, "B", rumorCreatedAt = 2))
        val merged = AdminModel.mergePending(known, listOf(PendingRequest(b, "B2", rumorCreatedAt = 3)))
        assertEquals(listOf("A", "B2"), merged.map { it.name })
        val roster = RosterContent(2, 1, null, null, listOf(RosterAttendee(o, "d", "organizer"), RosterAttendee(b, "d2", "attendee")))
        val visible = AdminModel.visiblePending(merged, { pk -> roster.attendees.any { it.pubkey == pk } }, emptySet(), setOf("x"))
        assertEquals(listOf(a), visible.map { it.attendeePubkey })
        val st = CoordinatorStatusContent(a = coord, pubkey = b, stage = "intro", state = "poison", at = 5)
        val people = AdminModel.buildApprovedPeople(roster, emptySet(), emptySet(), merged, statuses = listOf(st))
        assertEquals(listOf(o, b), people.map { it.pubkey })
        assertFalse(people[0].intakeAvailable)
        assertEquals("organizer", people[0].role)
        assertEquals(AdminModel.Op.FAILED, people[1].op)
    }

    @Test fun overviewPutsExceptionsFirstAndNeverCallsUnknownLiveness() {
        val (ex, metrics) = AdminModel.buildOverview(AdminModel.OverviewInput(2, 3, 1, 1, 0, true, true, true, true))
        assertEquals(listOf("failedJobs", "billing"), ex.map { it.id })
        val coordinator = metrics.single { it.id == "coordinator" }
        assertEquals("admin.overview.coord.unknown", coordinator.value)
        assertEquals(AdminModel.Tone.WARN, coordinator.tone)
        assertTrue(AdminModel.buildOverview(AdminModel.OverviewInput(0, 0, 0, 0, 0, false, false, false, false)).second.none { it.id == "coordinator" })
    }

    @Test fun statusDedupeKeepsNewestPerStageAndAttendee() {
        val p = CoordinatorStatusContent(a = coord, stage = "intro", pubkey = "a".repeat(64), state = "poison", at = 1)
        val c = p.copy(state = "cleared", at = 2)
        assertEquals(listOf(c), AdminModel.dedupeLatestStatuses(listOf(p, c)))
        assertEquals("admin.coord.minAgo" to 5, AdminModel.sinceLabel(1000, 1300))
    }

    @Test fun receiptAndCoordinatorHelpers() {
        val r = CreationReceipt.build(enrollAttempted = true, enrollFailed = true, coordinatorPicked = false, attachFailed = false, freshLocalKey = true, backupConfirmed = false)
        assertEquals(CreationReceipt.State.FAILED, r.enrolled)
        assertEquals(CreationReceipt.State.SKIPPED, r.grant)
        assertEquals(CreationReceipt.State.PENDING, r.backup)
        assertFalse(r.allSettled)
        val hex = "ab".repeat(32)
        assertEquals(hex, CoordinatorHelpers.parseKey(Nip19.npub(hex)))
        assertEquals(hex, CoordinatorHelpers.parseKey(hex.uppercase()))
        assertNull(CoordinatorHelpers.parseKey("npub1nope"))
        assertNull(CoordinatorHelpers.httpsUrl("javascript:alert(1)"))
        assertNull(CoordinatorHelpers.checkoutUrlForEvent("http://pay.example", "naddr1x"))
        assertEquals("https://pay.example/c?a=1&event=naddr1x", CoordinatorHelpers.checkoutUrlForEvent("https://pay.example/c?a=1", "naddr1x"))
        assertNull(CoordinatorHelpers.externalImageUrl("https://user:pw@x.example/a.png"))
        assertEquals("https://x.example/a.png", CoordinatorHelpers.externalImageUrl(" https://x.example/a.png "))
    }

    @Test fun languagesFoldDiacriticsAndPinTheUiLocale() {
        assertEquals(183, Languages.ALL.size)
        val (opts, pinned) = Languages.options("sk", listOf("de-AT"), listOf("en", "sk", "cs", "de", "es"))
        assertEquals(listOf("sk", "de", "en", "cs", "es"), opts.take(pinned).map { it.code })
        assertTrue(Languages.filter(opts, "slovencina").any { it.code == "sk" } || Languages.filter(opts, "slovak").any { it.code == "sk" })
        assertTrue(Languages.filter(opts, "ja").any { it.code == "ja" })
    }
}
