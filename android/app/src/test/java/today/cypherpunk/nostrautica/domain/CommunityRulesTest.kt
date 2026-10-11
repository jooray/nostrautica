package today.cypherpunk.nostrautica.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.organizer.CreateEventInput
import today.cypherpunk.nostrautica.domain.organizer.InboxFold
import today.cypherpunk.nostrautica.domain.organizer.OrganizerEvents
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Hierarchy
import today.cypherpunk.nostrautica.protocol.KeyGrantContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.ParentProof
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.Wire

/** The pure rules of the space hierarchy (§15) as the Android app applies them. */
class CommunityRulesTest {
    private val communityEid = Secp.generateSecret()
    private val eventEid = Secp.generateSecret()
    private val coordinatorSk = Secp.generateSecret()
    private val attendee = Secp.pubkeyHex(Secp.generateSecret())
    private val other = Secp.pubkeyHex(Secp.generateSecret())

    private val community = "31612:${Secp.pubkeyHex(communityEid)}:meetups"
    private val child = "31923:${Secp.pubkeyHex(eventEid)}:oct-meetup"
    private val otherChild = "31923:${Secp.pubkeyHex(Secp.generateSecret())}:rival"

    private fun cfg(eid: ByteArray, d: String, parent: String? = null, children: List<String> = emptyList(), coordinator: String? = null) = EventConfig(
        d = d, eidPubkey = Secp.pubkeyHex(eid), inbox = "1".repeat(64),
        coordinator = coordinator, coordinatorGen = if (coordinator != null) 1 else null,
        parent = parent, children = children,
    )

    private val communityCfg = cfg(communityEid, "meetups", children = listOf(child))
    private val childCfg = cfg(eventEid, "oct-meetup", parent = community)
    private val proof: ParentProof = Hierarchy.makeProof(eventEid, community, child, attendee).let { ParentProof(it.a, it.by, it.sig) }

    // ── The auto-join / offer decision table (§15.5) ─────────────────────────

    @Test fun decisionTableNeverJoinsWithoutAYes() {
        val d = CommunityJoinDecision.values()
        fun decide(hasProof: Boolean = true, consent: Boolean? = null, dismissed: Boolean = false, member: Boolean = false, pending: Boolean = false) =
            CommunityRules.decide(hasProof, consent, dismissed, member, pending)
        // No proof: nothing, whatever the consent says.
        assertEquals(CommunityJoinDecision.NONE, decide(hasProof = false, consent = true))
        // Already in / waiting: nothing, even with consent.
        assertEquals(CommunityJoinDecision.NONE, decide(consent = true, member = true))
        assertEquals(CommunityJoinDecision.NONE, decide(consent = true, pending = true))
        assertEquals(CommunityJoinDecision.NONE, decide(member = true))
        // Consent given at the join form: the ONLY path to JOIN.
        assertEquals(CommunityJoinDecision.JOIN, decide(consent = true))
        assertEquals(CommunityJoinDecision.JOIN, decide(consent = true, dismissed = true))
        // Said no: never nag, never offer.
        assertEquals(CommunityJoinDecision.NONE, decide(consent = false))
        // Never asked: a card, unless "Not now" was tapped.
        assertEquals(CommunityJoinDecision.OFFER, decide(consent = null))
        assertEquals(CommunityJoinDecision.NONE, decide(consent = null, dismissed = true))
        // Exhaustive: JOIN needs consent == true, whatever else is set.
        for (hasProof in listOf(true, false)) for (consent in listOf(true, false, null)) for (dismissed in listOf(true, false))
            for (member in listOf(true, false)) for (pending in listOf(true, false)) {
                val r = decide(hasProof, consent, dismissed, member, pending)
                if (r == CommunityJoinDecision.JOIN) assertTrue(hasProof && consent == true && !member && !pending)
                if (consent != true && r != CommunityJoinDecision.NONE) assertEquals(CommunityJoinDecision.OFFER, r)
            }
        assertEquals(3, d.size)
    }

    @Test fun aConsentForAnotherCommunityIsNotConsentForThisOne() {
        val stored = StoredParentProof(community, proof.by, proof.sig)
        assertNull(CommunityRules.applicableConsent(stored, ParentConsent("31612:${"a".repeat(64)}:elsewhere", true)))
        assertNotNull(CommunityRules.applicableConsent(stored, ParentConsent(community, true)))
        assertNull(CommunityRules.applicableConsent(stored, null))
        // A lost or foreign consent is "unknown", which offers; it never joins.
        assertEquals(CommunityJoinDecision.OFFER, CommunityRules.decide(true, null, false, isMember = false, isPending = false))
    }

    // ── Proof acceptance on a received grant (§15.3) ─────────────────────────

    @Test fun acceptsAnAuthoritysProofForThisAttendeeAndTheNamedCommunity() {
        val ok = CommunityRules.acceptProof(child, proof, childCfg, attendee)
        assertEquals(StoredParentProof(community, proof.by, proof.sig), ok)
    }

    @Test fun acceptsTheCoordinatorsProofToo() {
        val coordinator = Secp.pubkeyHex(coordinatorSk)
        val cfgWithCoordinator = childCfg.copy(coordinator = coordinator, coordinatorGen = 1)
        val p = Hierarchy.makeProof(coordinatorSk, community, child, attendee).let { ParentProof(it.a, it.by, it.sig) }
        assertNotNull(CommunityRules.acceptProof(child, p, cfgWithCoordinator, attendee))
        // ...but only while that coordinator is the event's current one.
        assertNull(CommunityRules.acceptProof(child, p, childCfg, attendee))
    }

    @Test fun rejectsProofsThatDoNotHold() {
        assertNull(CommunityRules.acceptProof(child, null, childCfg, attendee))
        // Someone else's proof replayed to this attendee.
        assertNull(CommunityRules.acceptProof(child, proof, childCfg, other))
        // The event's newest config names a different community (re-pointed) or none (unlinked).
        assertNull(CommunityRules.acceptProof(child, proof, childCfg.copy(parent = "31612:${"b".repeat(64)}:other"), attendee))
        assertNull(CommunityRules.acceptProof(child, proof, childCfg.copy(parent = null), attendee))
        // A proof for the right child signed by a stranger.
        val stranger = Hierarchy.makeProof(Secp.generateSecret(), community, child, attendee).let { ParentProof(it.a, it.by, it.sig) }
        assertNull(CommunityRules.acceptProof(child, stranger, childCfg, attendee))
        // Used for a different child.
        assertNull(CommunityRules.acceptProof(otherChild, proof, childCfg, attendee))
        // A tampered signature, and a malformed one.
        val flipped = (if (proof.sig.first() == '0') "1" else "0") + proof.sig.drop(1)
        assertNull(CommunityRules.acceptProof(child, proof.copy(sig = flipped), childCfg, attendee))
        assertNull(CommunityRules.acceptProof(child, proof.copy(sig = "zz"), childCfg, attendee))
        // A parent that is not a community coordinate.
        assertNull(CommunityRules.acceptProof(child, proof.copy(a = child), childCfg.copy(parent = null), attendee))
    }

    @Test fun grantContentCarriesTheProofOnTheWire() {
        val grant = KeyGrantContent(a = child, role = "attendee", eck = emptyList(), grantedBy = Secp.pubkeyHex(eventEid), parent = proof)
        val back = Wire.parse(KeyGrantContent.serializer(), Wire.encode(KeyGrantContent.serializer(), grant))
        assertEquals(proof, back.parent)
        assertNotNull(CommunityRules.acceptProof(child, back.parent, childCfg, attendee))
        // An unlinked event's grant has no parent field at all.
        assertFalse(Wire.encode(KeyGrantContent.serializer(), grant.copy(parent = null)).contains("\"parent\""))
    }

    // ── A community's children, sorted ───────────────────────────────────────

    private fun kid(title: String, start: Long?, coord: String = "31923:${"a".repeat(64)}:$title") = ChildSummary(coord, "naddr-$title", title, start)

    @Test fun childrenAreUpcomingSoonestFirstThenUndatedThenPastMostRecentFirst() {
        val now = 1_000L
        val sorted = CommunityRules.sortChildren(
            listOf(kid("past-old", 100), kid("later", 5_000), kid("undated", null), kid("past-new", 900), kid("soon", 1_500), kid("now", 1_000)),
            now,
        )
        assertEquals(listOf("now", "soon", "later", "undated", "past-new", "past-old"), sorted.map { it.title })
        val (upcoming, past) = CommunityRules.splitChildren(sorted, now)
        assertEquals(listOf("now", "soon", "later", "undated"), upcoming.map { it.title })
        assertEquals(listOf("past-new", "past-old"), past.map { it.title })
    }

    @Test fun childOrderIsDeterministicOnTies() {
        val a = kid("Alpha", 2_000, "31923:${"a".repeat(64)}:x")
        val b = kid("Alpha", 2_000, "31923:${"a".repeat(64)}:y")
        val c = kid("Beta", 2_000)
        assertEquals(listOf(a, b, c), CommunityRules.sortChildren(listOf(c, b, a), 0))
        assertEquals(listOf(a, b, c), CommunityRules.sortChildren(listOf(b, c, a), 0))
    }

    @Test fun withChildAddsOnceAndRemoves() {
        assertEquals(listOf("x", "y"), CommunityRules.withChild(listOf("x"), "y", true))
        assertEquals(listOf("x", "y"), CommunityRules.withChild(listOf("x", "y"), "y", true))
        assertEquals(listOf("x"), CommunityRules.withChild(listOf("x", "y"), "y", false))
    }

    // ── Admin queue verification (§15.4) ─────────────────────────────────────

    private fun claim(sk: ByteArray = eventEid, parent: String = community, ch: String = child, who: String = attendee) =
        Hierarchy.makeProof(sk, parent, ch, who).let { MemberOfClaim(ch, it.by, it.sig) }

    @Test fun aVerifiedClaimNeedsBothSidesTheAuthorityAndTheSignature() {
        val c = claim()
        assertTrue(CommunityRules.verifyMemberOfClaim(community, communityCfg, c, childCfg, attendee))
        // The child's config could not be fetched.
        assertFalse(CommunityRules.verifyMemberOfClaim(community, communityCfg, c, null, attendee))
        // One-sided links: the community does not list the child / the child does not name the community.
        assertFalse(CommunityRules.verifyMemberOfClaim(community, communityCfg.copy(children = emptyList()), c, childCfg, attendee))
        assertFalse(CommunityRules.verifyMemberOfClaim(community, communityCfg, c, childCfg.copy(parent = null), attendee))
        // Signed by a stranger, or for another attendee.
        assertFalse(CommunityRules.verifyMemberOfClaim(community, communityCfg, claim(sk = Secp.generateSecret()), childCfg, attendee))
        assertFalse(CommunityRules.verifyMemberOfClaim(community, communityCfg, c, childCfg, other))
    }

    @Test fun queueVerificationBadgesOnlyVerifiedRequestsAndIgnoresUnlistedChildren() {
        val unlisted = claim(ch = otherChild)
        val requests = listOf(
            attendee to listOf(claim()),
            other to listOf(claim(who = attendee)), // a replayed proof
            "c".repeat(64) to listOf(unlisted),      // a child the community does not list
            "d".repeat(64) to emptyList(),            // no claim at all
        )
        val configs = mapOf(child to childCfg, otherChild to cfg(Secp.generateSecret(), "rival", parent = community))
        val verified = CommunityRules.verifyQueue(community, communityCfg, requests, configs)
        assertEquals(mapOf(attendee to child), verified)
        // Only children the community lists are worth fetching, once each.
        assertEquals(setOf(child), CommunityRules.claimedChildren(communityCfg, requests.map { it.second }))
    }

    @Test fun aSecondClaimCanVerifyWhenTheFirstDoesNot() {
        val bad = MemberOfClaim(otherChild, "e".repeat(64), "f".repeat(128))
        val verified = CommunityRules.verifyQueue(community, communityCfg, listOf(attendee to listOf(bad, claim())), mapOf(child to childCfg))
        assertEquals(child, verified[attendee])
    }

    // ── The join request as the organizer's inbox reads it ───────────────────

    @Test fun inboxFoldKeepsMemberOfClaimsOffTheJoinRequest() {
        val c = claim()
        val tags = listOf(listOf("a", community), Hierarchy.memberOfTag(c.child, c.by, c.sig), listOf("member_of", "junk"))
        val content = """{"v":2,"name":"Ann","message":"","rsvp_public":false}"""
        val u = UnsignedEvent(attendee, 10, Kinds.JOIN_REQUEST, tags, content)
        val out = InboxFold.fold(listOf(Rumor(u.id, attendee, 10, Kinds.JOIN_REQUEST, tags, content)), community)
        assertEquals(listOf(c), out.single().memberOf)
        // An ordinary join has none.
        val plain = UnsignedEvent(other, 11, Kinds.JOIN_REQUEST, emptyList(), content)
        assertTrue(InboxFold.fold(listOf(Rumor(plain.id, other, 11, Kinds.JOIN_REQUEST, emptyList(), content)), community).single().memberOf.isEmpty())
    }

    // ── Creating an event inside a community ─────────────────────────────────

    @Test fun createdEventNamesItsCommunityAndRoundTrips() {
        val created = OrganizerEvents.buildCreate(CreateEventInput(title = "October meetup", summary = "", start = 2_000_000_000, parent = community))
        assertEquals(community, created.config.parent)
        val parsed = EventConfig.parse(created.configEvent)
        assertEquals(community, parsed.parent)
        assertTrue(parsed.children.isEmpty())
    }

    @Test fun aCommunityNeverNamesAParent() {
        val created = OrganizerEvents.buildCreate(CreateEventInput(title = "Meetups", summary = "", community = true, parent = community))
        assertNull(created.config.parent)
        assertNull(EventConfig.parse(created.configEvent).parent)
    }

    @Test fun republishedConfigKeepsBothHalvesOfTheLink() {
        val withChildren = communityCfg.copy(children = listOf(child, otherChild))
        val parsed = EventConfig.parse(withChildren.eidPubkey, OrganizerEvents.configTags(withChildren))
        assertEquals(listOf(child, otherChild), parsed.children)
        val linked = EventConfig.parse(childCfg.eidPubkey, OrganizerEvents.configTags(childCfg))
        assertTrue(Hierarchy.isLinked(community, parsed, child, linked))
    }
}
