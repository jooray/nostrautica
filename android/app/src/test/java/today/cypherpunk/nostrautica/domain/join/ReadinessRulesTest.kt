package today.cypherpunk.nostrautica.domain.join

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.AiProfile
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent

/** Ported from packages/app/src/lib/events/readiness.test.ts. */
class ReadinessRulesTest {
    private fun base(
        role: String = "attendee",
        signerHoldsKey: Boolean = false,
        backupAcked: Boolean? = true,
        hasIntro: Boolean? = true,
        profileEmpty: Boolean? = null,
        processed: Boolean? = true,
        processingFailed: ProcessingFailure? = null,
        matchesAvailable: Boolean? = true,
        matchingEnabled: Boolean = true,
        hasCoordinator: Boolean = true,
        latched: Set<StepId> = emptySet(),
    ) = ReadinessRules.derive(ReadinessInput(role, signerHoldsKey, backupAcked, hasIntro, profileEmpty, processed, processingFailed, matchesAvailable, matchingEnabled, hasCoordinator, latched))

    private fun Readiness.state(id: StepId) = steps.first { it.id == id }.state

    @Test fun fullyReadyMember() {
        val r = base()
        assertEquals(StepId.entries.toList(), r.steps.map { it.id })
        assertTrue(r.allComplete)
        assertEquals(-1, r.currentIndex)
        assertEquals(5, r.doneCount)
        assertNull(r.primary)
        assertTrue(r.matchesReady)
    }

    @Test fun noIntroMeansRecordCta() {
        val r = base(hasIntro = false, processed = null, matchesAvailable = false)
        assertEquals(StepState.ACTION_REQUIRED, r.state(StepId.INTRO))
        assertEquals(StepState.CHECKING, r.state(StepId.PROCESSING))
        assertEquals(StepState.WAITING, r.state(StepId.MATCHES))
        assertEquals(Cta("readiness.cta.record", CtaTarget.RECORD), r.primary)
    }

    @Test fun matchingIsNotGatedOnIntro() {
        val r = base(hasIntro = false)
        assertEquals(StepState.ACTION_REQUIRED, r.state(StepId.INTRO))
        assertEquals(StepState.COMPLETE, r.state(StepId.PROCESSING))
        assertTrue(r.matchesReady)
    }

    @Test fun visitorGetsJoinCta() {
        val r = base(role = "visitor", backupAcked = false, hasIntro = false)
        assertEquals(StepState.ACTION_REQUIRED, r.state(StepId.JOINED))
        assertEquals(CtaTarget.JOIN, r.primary?.target)
        assertFalse(r.viewerIsMember)
    }

    @Test fun unknownRoleIsCheckingWithoutCta() {
        val r = base(role = "unknown", backupAcked = false, hasIntro = false)
        assertEquals(StepState.CHECKING, r.state(StepId.JOINED))
        assertNull(r.primary)
        assertEquals(StepState.COMPLETE, base(role = "unknown", latched = setOf(StepId.JOINED)).state(StepId.JOINED))
    }

    @Test fun unknownBackupIsCheckingNotSecured() {
        val r = base(backupAcked = null)
        assertEquals(StepState.CHECKING, r.state(StepId.BACKUP))
        assertEquals("readiness.hint.checking", r.steps[1].hintKey)
    }

    @Test fun pendingViewerIsNeverPushedToBackupOrIntro() {
        val r = base(role = "pending", backupAcked = false, hasIntro = false)
        assertEquals(StepState.IN_PROGRESS, r.state(StepId.JOINED))
        assertEquals("readiness.hint.pending", r.steps[0].hintKey)
        assertNull(r.primary)
    }

    @Test fun threeStepsWithoutCoordinatorOrMatching() {
        assertEquals(3, base(hasCoordinator = false).steps.size)
        assertEquals(3, base(matchingEnabled = false).steps.size)
    }

    @Test fun backupCtaAndSignerHeldKey() {
        val r = base(backupAcked = false)
        assertEquals(StepState.ACTION_REQUIRED, r.state(StepId.BACKUP))
        assertEquals(CtaTarget.BACKUP, r.primary?.target)
        val remote = base(signerHoldsKey = true, backupAcked = null)
        assertEquals(StepState.COMPLETE, remote.state(StepId.BACKUP))
        assertEquals("readiness.hint.signerKey", remote.steps[1].hintKey)
    }

    @Test fun unknownIntroIsCheckingAndLatchWins() {
        val r = base(hasIntro = null)
        assertEquals(StepState.CHECKING, r.state(StepId.INTRO))
        assertNull(r.primary)
        assertEquals(StepState.COMPLETE, base(hasIntro = null, latched = setOf(StepId.INTRO)).state(StepId.INTRO))
    }

    @Test fun processingInProgressAndMatchesWaiting() {
        val r = base(processed = false, matchesAvailable = false)
        assertEquals(StepState.IN_PROGRESS, r.state(StepId.PROCESSING))
        assertEquals(StepState.WAITING, r.state(StepId.MATCHES))
        assertFalse(r.matchesReady)
    }

    @Test fun emptyProfilePointsAtTheEditor() {
        val r = base(hasIntro = false, profileEmpty = true)
        assertEquals("readiness.hint.empty", r.steps[2].hintKey)
        assertEquals(Cta("readiness.cta.profile", CtaTarget.MY_PROFILE), r.primary)
        assertEquals("readiness.hint.intro", base(hasIntro = false, profileEmpty = false).steps[2].hintKey)
        assertEquals("readiness.hint.intro", base(hasIntro = false, profileEmpty = null).steps[2].hintKey)
    }

    @Test fun mediaFailureMeansRerecord() {
        val r = base(processed = false, matchesAvailable = false, processingFailed = ProcessingFailure("process_attendee", "media_processing", true))
        assertEquals(StepState.FAILED, r.state(StepId.PROCESSING))
        assertEquals("readiness.hint.failedMedia", r.steps[3].hintKey)
        assertEquals(Cta("readiness.cta.rerecord", CtaTarget.RECORD), r.primary)
    }

    @Test fun otherFailuresMeanEditProfile() {
        for (cat in listOf("provider_contract", "processing_error", "internal", null)) {
            val r = base(processed = false, matchesAvailable = false, processingFailed = ProcessingFailure("process_attendee", cat, null))
            assertEquals("readiness.hint.failed", r.steps[3].hintKey)
            assertEquals(Cta("readiness.cta.editProfile", CtaTarget.MY_PROFILE), r.primary)
        }
    }

    @Test fun failureOutranksIntroNudge() {
        val r = base(hasIntro = false, processed = false, matchesAvailable = false, processingFailed = ProcessingFailure("process_attendee", "media_fetch", null))
        assertEquals(StepState.ACTION_REQUIRED, r.state(StepId.INTRO))
        assertEquals(CtaTarget.RECORD, r.primary?.target)
        assertEquals("readiness.cta.rerecord", r.primary?.labelKey)
    }

    @Test fun builtProfileIsNeverUnbuilt() {
        assertEquals(StepState.COMPLETE, base(processingFailed = ProcessingFailure("process_attendee", "media_fetch", null)).state(StepId.PROCESSING))
    }

    @Test fun latchBeatsUncorroboratedFailure() {
        val r = base(processed = null, matchesAvailable = false, latched = setOf(StepId.PROCESSING), processingFailed = ProcessingFailure("process_attendee", "media_fetch", null))
        assertEquals(StepState.COMPLETE, r.state(StepId.PROCESSING))
    }

    @Test fun latchDoesNotHideAProvenFailure() {
        val r = base(processed = false, matchesAvailable = false, latched = StepId.entries.toSet(), processingFailed = ProcessingFailure("process_attendee", "provider_contract", null))
        assertEquals(StepState.FAILED, r.state(StepId.PROCESSING))
        assertFalse(r.allComplete)
        assertEquals("readiness.cta.editProfile", r.primary?.labelKey)
    }

    @Test fun nonMemberNeverGetsProcessingCta() {
        assertNull(base(role = "pending", processed = false, matchesAvailable = false, processingFailed = ProcessingFailure("process_attendee", "media_fetch", null)).primary)
    }

    @Test fun atMostOnePrimaryAndRoleAppropriate() {
        for (role in listOf("visitor", "pending", "attendee", "organizer", "unknown")) for (b in listOf(true, false, null)) for (i in listOf(true, false, null)) {
            val r = base(role = role, backupAcked = b, hasIntro = i)
            val member = role == "attendee" || role == "organizer"
            if (!member) assertTrue(r.primary == null || r.primary?.target == CtaTarget.JOIN)
        }
    }

    private fun entry(about: String = "", skills: List<String> = emptyList(), lookingFor: String = "", intro: String? = null, ai: AiProfile? = null) =
        DirectoryEntryContent(pubkey = "a".repeat(64), profile = AttendeeProfile(about, skills, lookingFor, emptyList()), introText = intro, aiProfile = ai, updatedAt = 1)

    @Test fun hasAnythingToMatchOn() {
        assertFalse(ReadinessRules.hasAnythingToMatchOn(null))
        assertFalse(ReadinessRules.hasAnythingToMatchOn(entry()))
        assertTrue(ReadinessRules.hasAnythingToMatchOn(entry(about = "I build things")))
        assertTrue(ReadinessRules.hasAnythingToMatchOn(entry(skills = listOf("rust"))))
        assertTrue(ReadinessRules.hasAnythingToMatchOn(entry(lookingFor = "co-founder")))
        assertTrue(ReadinessRules.hasAnythingToMatchOn(entry(intro = "hello")))
        assertTrue(ReadinessRules.hasAnythingToMatchOn(entry(ai = AiProfile(summary = "derived from notes"))))
        assertFalse(ReadinessRules.hasAnythingToMatchOn(entry(ai = AiProfile(summary = " "))))
    }
}
