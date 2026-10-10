package today.cypherpunk.nostrautica.domain.people

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.ProfileMeta
import today.cypherpunk.nostrautica.protocol.AiProfile
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.Match
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import today.cypherpunk.nostrautica.protocol.ProfileTranslation
import java.time.ZoneOffset

class PeopleLogicTest {
    private fun pk(n: Int) = n.toString(16).padStart(64, '0')
    private fun m(n: Int, score: Double, comp: Double = 0.5, sim: Double = 0.5) = Match(pk(n), score, sim, comp, "reason $n")
    private fun entry(n: Int, name: String? = null, about: String = "", skills: List<String> = emptyList(), ai: AiProfile? = null, intro: String? = null) =
        DirectoryEntryContent(pubkey = pk(n), name = name, profile = AttendeeProfile(about = about, skills = skills), aiProfile = ai, introText = intro, updatedAt = 1)

    // ── confidence ──

    @Test fun strongCutIsTheThirdBestButNeverUnderTheFloor() {
        assertEquals(0.9, Confidence.strongCutFor(listOf(m(1, 0.95), m(2, 0.92), m(3, 0.9), m(4, 0.85))), 1e-9)
        assertEquals(0.75, Confidence.strongCutFor(listOf(m(1, 0.7), m(2, 0.65))), 1e-9)
        assertEquals(0.75, Confidence.strongCutFor(emptyList()), 1e-9)
        // Fewer than three: the last one is the cut.
        assertEquals(0.8, Confidence.strongCutFor(listOf(m(1, 0.9), m(2, 0.8))), 1e-9)
    }

    @Test fun tiesAtTheCutAllBandStrong() {
        val list = listOf(m(1, 0.95), m(2, 0.95), m(3, 0.95), m(4, 0.95), m(5, 0.7))
        val cut = Confidence.strongCutFor(list)
        assertEquals(4, list.count { Confidence.bandAtCut(it.score, cut) == Band.STRONG })
        assertEquals(Band.GOOD, Confidence.bandAtCut(0.7, cut))
        assertEquals(Band.HELLO, Confidence.bandAtCut(0.59, cut))
        assertEquals(Band.HELLO, Confidence.bandAtCut(Double.NaN, cut))
    }

    @Test fun rankBreaksTiesOnComplementarityThenSimilarity() {
        val a = m(1, 0.9, comp = 0.5, sim = 0.9)
        val b = m(2, 0.9, comp = 0.8, sim = 0.1)
        val c = m(3, 0.9, comp = 0.8, sim = 0.2)
        val d = m(4, Double.NaN)
        assertEquals(listOf(c, b, a, d).map { it.pubkey }, listOf(a, d, b, c).sortedWith(Confidence.byMatchRank).map { it.pubkey })
    }

    @Test fun featuredPromotesHelloOnlyWhenNothingBetter() {
        val list = listOf(m(1, 0.95), m(2, 0.7), m(3, 0.4))
        val cut = Confidence.strongCutFor(list)
        val bandOf = { x: Match -> Confidence.bandAtCut(x.score, cut) }
        assertEquals(listOf(Band.STRONG, Band.GOOD), Featured.sections(list, bandOf).map { it.band })
        val weak = listOf(m(1, 0.4), m(2, 0.3))
        val wcut = Confidence.strongCutFor(weak)
        val sections = Featured.sections(weak) { Confidence.bandAtCut(it.score, wcut) }
        assertEquals(listOf(Band.HELLO), sections.map { it.band })
        assertTrue(Featured.noStrong(true, weak) { Confidence.bandAtCut(it.score, wcut) })
        assertFalse(Featured.noStrong(false, weak) { Band.HELLO })
        assertTrue(Featured.sections(emptyList()) { Band.HELLO }.isEmpty())
    }

    // ── search ──

    @Test fun searchFoldsDiacriticsAndRanksNameHitsFirst() {
        assertTrue(Search.matchesQuery("Ján Černý", "cerny jan"))
        assertFalse(Search.matchesQuery("Ján Černý", "novak"))
        assertTrue(Search.matchesQuery("anything", "   "))
        val a = entry(1, about = "loves rust")
        val b = entry(2)
        val names = mapOf(pk(1) to "Alice", pk(2) to "Rusty Bob")
        val ranked = Search.rank(listOf(a, b), "rust") { Search.fields(it, names[it.pubkey]!!, "en") }
        assertEquals(listOf(pk(2), pk(1)), ranked.map { it.pubkey })
    }

    @Test fun searchIncludesTheTranslationOnlyInItsLanguage() {
        val e = entry(1, ai = AiProfile(summary = "", translations = ProfileTranslation(lang = "sk", about = "programátorka")))
        assertTrue(Search.matchesQuery(Search.fields(e, "X", "sk").rest.joinToString(" "), "programatorka"))
        assertFalse(Search.matchesQuery(Search.fields(e, "X", "en").rest.joinToString(" "), "programatorka"))
    }

    // ── names ──

    @Test fun namePrecedence() {
        val e = entry(1, name = "Entry Name", about = "A very long bio that goes on and on past forty characters for sure")
        assertEquals("Kind0", PeopleNames.nameOf(pk(1), ProfileMeta(pk(1), name = "Kind0"), e))
        assertEquals("Entry Name", PeopleNames.nameOf(pk(1), ProfileMeta(pk(1), name = ""), e))
        assertEquals(e.profile.about.take(40), PeopleNames.nameOf(pk(1), null, entry(1), e.profile.about))
        assertEquals(pk(1).take(10) + "…", PeopleNames.nameOf(pk(1), null, null))
        val k0 = JsonObject(mapOf("name" to JsonPrimitive("ada1815"), "display_name" to JsonPrimitive("Ada Lovelace")))
        assertEquals("Ada Lovelace", PeopleNames.attendeeDisplayName(k0, e, "Attendee"))
        assertEquals("Attendee", PeopleNames.attendeeDisplayName(null, null, "Attendee"))
    }

    @Test fun bioPrefersTheTranslationThenTheEventBioThenKind0() {
        val tr = entry(1, about = "Hello", ai = AiProfile(summary = "", translations = ProfileTranslation(lang = "sk", about = "Ahoj")))
        assertEquals("Ahoj", PeopleNames.bioOf(tr, null, "sk"))
        assertEquals("Hello", PeopleNames.bioOf(tr, null, "en"))
        assertEquals("live", PeopleNames.bioOf(entry(1), ProfileMeta(pk(1), about = "live"), "en"))
        assertEquals("", PeopleNames.nostrAbout(" same ", "same"))
        assertEquals("new bio", PeopleNames.nostrAbout("new bio", "old bio"))
        assertEquals("", PeopleNames.nostrAbout(null, "x"))
    }

    // ── list states ──

    @Test fun emptyReasonOrder() {
        assertEquals(EmptyReason.LOADING, RosterState.emptyReason(true, false, 3, false, false))
        assertEquals(EmptyReason.NOT_APPROVED, RosterState.emptyReason(false, false, 3, true, true))
        assertEquals(EmptyReason.STALE_KEY, RosterState.emptyReason(false, true, 3, false, false))
        assertEquals(EmptyReason.UNREACHABLE, RosterState.emptyReason(false, true, 0, false, true))
        assertEquals(EmptyReason.UNREACHABLE, RosterState.emptyReason(false, true, 0, true, false))
        assertEquals(EmptyReason.NONE, RosterState.emptyReason(false, true, 0, true, true))
    }

    @Test fun staleCueOnlyForASettledUnconfirmedNonEmptyList() {
        assertFalse(RosterState.staleCue(0, true, false, 5).show)
        assertFalse(RosterState.staleCue(3, false, false, 5).show)
        assertFalse(RosterState.staleCue(3, true, true, 5).show)
        assertEquals(RosterState.StaleCue(true, 5), RosterState.staleCue(3, true, false, 5))
        assertEquals(RosterState.StaleCue(true, null), RosterState.staleCue(3, true, false, null))
    }

    @Test fun asOfCarriesTheDateWhenNotToday() {
        val now = 1_760_000_000_000L
        val today = RosterState.formatAsOf(now - 60_000, now, "en", ZoneOffset.UTC)
        val older = RosterState.formatAsOf(now - 8 * 86_400_000L, now, "en", ZoneOffset.UTC)
        assertFalse(today.contains("2025"))
        assertTrue(older.contains("2025"))
    }

    @Test fun directoryRowsHideFeaturedAndLeadWithNewcomersUnlessFiltering() {
        val list = (1..5).map { entry(it) }
        val f = { e: DirectoryEntryContent -> Search.Fields(e.pubkey, emptyList()) }
        val rows = Directory.rows(list, "", false, { true }, setOf(pk(1)), setOf(pk(4)), f)
        assertEquals(listOf(pk(4), pk(2), pk(3), pk(5)), rows.map { it.pubkey })
        val filtered = Directory.rows(list, "", true, { it != pk(2) }, setOf(pk(1)), setOf(pk(4)), f)
        assertEquals(listOf(pk(1), pk(3), pk(4), pk(5)), filtered.map { it.pubkey })
    }

    // ── what's new ──

    @Test fun nobodyIsNewWithoutABaselineButNewMatchesAlwaysAre() {
        val wm = Watermark()
        assertEquals(listOf(pk(9)), WhatsNewRules.newSince(listOf(pk(9)), listOf(pk(1), pk(2)), wm))
        val seen = Watermark(seenMatches = listOf(pk(9)), seenPeople = listOf(pk(1)))
        assertEquals(listOf(pk(2)), WhatsNewRules.newSince(listOf(pk(9)), listOf(pk(1), pk(2)), seen))
        // Deduped: a new match that is also a new arrival counts once.
        assertEquals(listOf(pk(3)), WhatsNewRules.newSince(listOf(pk(3)), listOf(pk(3)), Watermark(seenPeople = emptyList())))
        assertTrue(WhatsNewRules.approvalIsNew(true, Watermark()))
        assertFalse(WhatsNewRules.approvalIsNew(true, Watermark(seenApproved = true)))
    }

    // ── report ──

    @Test fun reportSectionsAndFollowTargets() {
        val s = PerEventSettings(wantToMeet = listOf(pk(1), pk(2)), met = listOf(pk(2), pk(3)), notes = linkedMapOf(pk(3) to "  met at lunch ", pk(4) to "   "))
        val r = Report.assemble(s, emptyList()) { "N" + it.takeLast(1) }
        assertEquals(listOf(pk(2), pk(3)), r.met.map { it.pubkey })
        assertEquals(listOf(pk(1)), r.wantedNotMet.map { it.pubkey })
        assertEquals(listOf(pk(3)), r.notes.map { it.pubkey })
        assertEquals("met at lunch", r.met[1].note)
        assertEquals(listOf(pk(2), pk(3), pk(1)), r.allPeople.map { it.pubkey })
        assertEquals(listOf(pk(2), pk(1)), Report.followTargets(s, setOf(pk(3))))
        assertTrue(r.met[0].npub.startsWith("npub1"))
        assertTrue(Report.npubList(r.met).lines()[1].endsWith("N3  (met at lunch)"))
        assertTrue(Report.assemble(PerEventSettings(), emptyList()) { it }.isEmpty)
    }

    @Test fun settingsToggleAndNotes() {
        var s = PerEventSettings()
        s = SettingsRules.toggled(s, SettingList.WANT_TO_MEET, pk(1))
        assertTrue(SettingsRules.has(s, SettingList.WANT_TO_MEET, pk(1)))
        s = SettingsRules.toggled(s, SettingList.WANT_TO_MEET, pk(1))
        assertFalse(SettingsRules.has(s, SettingList.WANT_TO_MEET, pk(1)))
        s = SettingsRules.withNote(s, pk(2), "  hi ")
        assertEquals("hi", s.notes[pk(2)])
        s = SettingsRules.withNote(s, pk(2), "   ")
        assertFalse(pk(2) in s.notes)
        assertFalse(SettingsRules.has(null, SettingList.MET, pk(1)))
    }

    @Test fun introIsARecordingOrAText() {
        assertFalse(IntroRules.hasIntro(entry(1, about = "bio")))
        assertTrue(IntroRules.hasIntro(entry(1, intro = "hello")))
        assertFalse(IntroRules.hasIntro(entry(1, intro = "  ")))
    }
}
