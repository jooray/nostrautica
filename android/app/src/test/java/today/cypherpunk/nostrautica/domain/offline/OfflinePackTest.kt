package today.cypherpunk.nostrautica.domain.offline

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The offline pack's orchestration (offline-pack.ts buildOfflinePack + packComplete). */
class OfflinePackTest {
    /** Records every call; [fail] names the steps that throw. */
    private class Fake(
        val fail: Set<String> = emptySet(),
        val people: List<String> = listOf("a", "b", "c"),
        val speakers: List<String> = listOf("c", "d"),
        val urls: List<String> = listOf("https://x/1", "https://x/2", "https://x/2"),
        val badImages: Set<String> = emptySet(),
        var bytes: Long? = 1_000L,
    ) : PackSources {
        val calls = mutableListOf<String>()
        var profiled: List<String> = emptyList()
        val images = java.util.Collections.synchronizedList(mutableListOf<String>())

        private fun hit(name: String) { calls += name; if (name in fail) throw java.io.IOException(name) }

        override suspend fun roster(): Int { hit("roster"); return people.size }
        override suspend fun directory(): List<String> { hit("directory"); return people }
        override suspend fun matches(): Int { hit("matches"); return 2 }
        override suspend fun talks(): List<String> { hit("talks"); return speakers }
        override suspend fun profiles(pubkeys: List<String>) { profiled = pubkeys; hit("profiles") }
        override suspend fun pictureUrls(pubkeys: List<String>): List<String> { hit("pictures"); return urls }
        override suspend fun prefetchImage(url: String): Boolean { images += url; return url !in badImages }
        override suspend fun page() { hit("page"); bytes = bytes?.plus(250_000) }
        override fun storageBytes(): Long? = bytes
    }

    private val all = PackPlan(matching = true, talks = true, pictures = true)

    private fun build(plan: PackPlan, src: Fake, progress: MutableList<List<PackStep>> = mutableListOf()) =
        runBlocking { OfflinePackRules.build(plan, src, { 42L }) { progress += it } }

    @Test fun runsEveryStepInOrderAndCountsWhatItCached() {
        val src = Fake()
        val pack = build(all, src)
        assertEquals(listOf("roster", "directory", "matches", "talks", "profiles", "pictures", "page"), src.calls)
        assertEquals(OfflinePackRules.STEPS, pack.steps.map { it.key })
        val counts = pack.steps.associate { it.key to it.count }
        assertEquals(3, counts[Step.ROSTER])
        assertEquals(3, counts[Step.DIRECTORY])
        assertEquals(2, counts[Step.MATCHES])
        assertEquals(2, counts[Step.TALKS])
        // Directory people plus talk speakers, deduped.
        assertEquals(listOf("a", "b", "c", "d"), src.profiled)
        assertEquals(4, counts[Step.PROFILES])
        // Duplicate URLs are fetched once.
        assertEquals(2, counts[Step.PICTURES])
        assertEquals(2, src.images.size)
        assertTrue(OfflinePackRules.complete(pack))
        assertTrue(pack.mediaSkipped)
        assertEquals(42L, pack.at)
        assertEquals(250_000L, pack.bytesAdded)
    }

    @Test fun reportsProgressAfterEveryStep() {
        val progress = mutableListOf<List<PackStep>>()
        build(all, Fake(), progress)
        assertEquals((1..OfflinePackRules.STEPS.size).toList(), progress.map { it.size })
        assertEquals(OfflinePackRules.STEPS, progress.last().map { it.key })
    }

    @Test fun aFailedStepIsRecordedAndTheRestStillRun() {
        val src = Fake(fail = setOf("matches", "page"))
        val pack = build(all, src)
        assertEquals(7, src.calls.size)
        val byKey = pack.steps.associateBy { it.key }
        assertFalse(byKey.getValue(Step.MATCHES).ok)
        assertEquals(0, byKey.getValue(Step.MATCHES).count)
        assertFalse(byKey.getValue(Step.PAGE).ok)
        assertTrue(byKey.getValue(Step.TALKS).ok)
        assertFalse(OfflinePackRules.complete(pack))
    }

    @Test fun aFailedDirectoryLeavesOnlySpeakersToProfile() {
        val src = Fake(fail = setOf("directory"))
        val pack = build(all, src)
        assertEquals(listOf("c", "d"), src.profiled)
        assertFalse(OfflinePackRules.complete(pack))
    }

    @Test fun stepsThatDontApplyAreSkippedAndDontBlockCompleteness() {
        val src = Fake(speakers = emptyList())
        val pack = build(PackPlan(matching = false, talks = false, pictures = false), src)
        assertEquals(listOf("roster", "directory", "profiles", "page"), src.calls)
        val skipped = pack.steps.filter { it.skipped }.map { it.key }
        assertEquals(listOf(Step.MATCHES, Step.TALKS, Step.PICTURES), skipped)
        assertTrue(src.images.isEmpty())
        assertTrue(OfflinePackRules.complete(pack))
    }

    @Test fun picturesOffFetchesNoImages() {
        val src = Fake()
        build(all.copy(pictures = false), src)
        assertFalse("pictures" in src.calls)
        assertTrue(src.images.isEmpty())
    }

    @Test fun nobodyToProfileSkipsProfiles() {
        val src = Fake(people = emptyList(), speakers = emptyList(), urls = emptyList())
        val pack = build(all, src)
        val profiles = pack.steps.first { it.key == Step.PROFILES }
        assertTrue(profiles.skipped)
        // Pictures still ran (the event's own images), found nothing, and that is fine.
        val pictures = pack.steps.first { it.key == Step.PICTURES }
        assertTrue(pictures.ok)
        assertEquals(0, pictures.count)
        assertTrue(OfflinePackRules.complete(pack))
    }

    @Test fun oneBrokenPictureHostDoesNotMakeThePackPartial() {
        val pack = build(all, Fake(badImages = setOf("https://x/1")))
        val pictures = pack.steps.first { it.key == Step.PICTURES }
        assertTrue(pictures.ok)
        assertEquals(1, pictures.count)
        assertTrue(OfflinePackRules.complete(pack))
    }

    @Test fun everyPictureFailingIsAFailedStep() {
        val pack = build(all, Fake(badImages = setOf("https://x/1", "https://x/2")))
        assertFalse(pack.steps.first { it.key == Step.PICTURES }.ok)
        assertFalse(OfflinePackRules.complete(pack))
    }

    @Test fun picturesAreCapped() {
        val urls = (1..OfflinePackRules.MAX_PICTURES + 50).map { "https://x/$it" }
        val src = Fake(urls = urls)
        build(all, src)
        assertEquals(OfflinePackRules.MAX_PICTURES, src.images.size)
    }

    @Test fun unknownStorageLeavesBytesAddedOut() {
        assertNull(build(all, Fake(bytes = null)).bytesAdded)
        assertEquals(0L, OfflinePackRules.bytesAdded(500, 400))
    }

    @Test fun thePackRoundTripsThroughTheCacheJson() {
        val pack = build(all, Fake(fail = setOf("talks")))
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
        val text = json.encodeToString(OfflinePack.serializer(), pack)
        assertTrue(text.contains("\"key\":\"talks\""))
        assertEquals(pack, json.decodeFromString(OfflinePack.serializer(), text))
    }
}
