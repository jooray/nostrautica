package today.cypherpunk.nostrautica.domain.offline

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The offline event pack (events/offline-pack.ts, spec §13): one tap pre-downloads
 * what an attendee needs at a venue with no signal by running the app's existing
 * fetchers, which all write through the owner-scoped cache, so People, Matches,
 * Talks and the event page then open from the phone.
 *
 * Same contract as the PWA: a failed step is recorded (ok = false) and the rest
 * still run, so a partial pack is useful and re-runnable; audio/video blobs are
 * NOT downloaded (descriptors only, playback stays on demand). The PWA's
 * `shell`/`modules` steps have no counterpart: a native app's screens are on the
 * phone already. Android adds [Step.PICTURES]: profile pictures warmed into the
 * image cache, only when "Load profile pictures from other servers" is on, since a
 * browser keeps the pictures it has shown and Coil's disk cache does the same here.
 */
@Serializable
enum class Step {
    @SerialName("roster") ROSTER,
    @SerialName("directory") DIRECTORY,
    @SerialName("matches") MATCHES,
    @SerialName("talks") TALKS,
    @SerialName("profiles") PROFILES,
    @SerialName("pictures") PICTURES,
    @SerialName("page") PAGE,
}

@Serializable
data class PackStep(
    val key: Step,
    /** Completed successfully (or was legitimately empty). */
    val ok: Boolean,
    /** How many records the step cached (attendees, entries, matches, …). */
    val count: Int,
    /** The step doesn't apply to this event (no coordinator, talks off, pictures off). */
    val skipped: Boolean = false,
)

@Serializable
data class OfflinePack(
    /** Unix seconds. */
    val at: Long,
    val steps: List<PackStep>,
    /** Media blobs were not downloaded (descriptors only). Always true, as on the web. */
    val mediaSkipped: Boolean = true,
    /** On-device bytes this build added (database + image cache), when measurable. */
    val bytesAdded: Long? = null,
)

/** The fetchers the pack drives. Each throws when it could not do its job. */
interface PackSources {
    /** Fetch and decrypt the roster; the number of attendees. */
    suspend fun roster(): Int
    /** Fetch and decrypt the directory; the entries' pubkeys. */
    suspend fun directory(): List<String>
    /** Fetch and decrypt this user's matches; how many. */
    suspend fun matches(): Int
    /** Fetch and decrypt the talks; the speakers' pubkeys, one per talk. */
    suspend fun talks(): List<String>
    /** Fetch kind-0 profiles; throws when a batch went unanswered. */
    suspend fun profiles(pubkeys: List<String>)
    /** Safe (https) picture URLs for these people plus the event's own images, from the phone. */
    suspend fun pictureUrls(pubkeys: List<String>): List<String>
    /** Warm one image into the disk cache; false when it could not be loaded. */
    suspend fun prefetchImage(url: String): Boolean
    /** Event page + posts; throws when a relay set went unanswered. */
    suspend fun page()
    /** Bytes the app currently keeps on the device, or null when unknown. */
    fun storageBytes(): Long?
}

/** What the event offers, which decides the skipped steps. */
data class PackPlan(
    /** A coordinator runs matching for this event (`matches` applies). */
    val matching: Boolean,
    /** Talks are on (`talks` applies). */
    val talks: Boolean,
    /** "Load profile pictures from other servers" is on (`pictures` applies). */
    val pictures: Boolean,
)

object OfflinePackRules {
    /**
     * Every step, in order. The "{n} of {total}" counter derives its total from this
     * list rather than a number in the string (the PWA's counter once read "8 of 6").
     */
    val STEPS: List<Step> = Step.entries

    /** Pictures fetched at once, and at most per pack (a 300-person event stays bounded). */
    const val PICTURE_PARALLELISM = 4
    const val MAX_PICTURES = 400

    /** Below this, a re-download "added" nothing worth naming (the PWA's 100 kB). */
    const val MIN_REPORTED_BYTES = 100_000L

    /** Every applicable (non-skipped) step succeeded. */
    fun complete(pack: OfflinePack): Boolean = pack.steps.filter { !it.skipped }.all { it.ok }

    fun bytesAdded(before: Long?, after: Long?): Long? =
        if (before != null && after != null) maxOf(0L, after - before) else null

    /**
     * Build the pack. A failed step is recorded and the rest run on; [onProgress]
     * gets the steps so far after each one.
     */
    suspend fun build(plan: PackPlan, src: PackSources, now: () -> Long, onProgress: (List<PackStep>) -> Unit = {}): OfflinePack {
        val before = runCatching { src.storageBytes() }.getOrNull()
        val steps = mutableListOf<PackStep>()
        fun record(s: PackStep) { steps += s; onProgress(steps.toList()) }
        suspend fun run(key: Step, skipped: Boolean, fn: suspend () -> Int) {
            if (skipped) return record(PackStep(key, ok = true, count = 0, skipped = true))
            record(
                runCatching { fn() }.fold(
                    { PackStep(key, ok = true, count = it) },
                    { e -> if (e is kotlinx.coroutines.CancellationException) throw e; PackStep(key, ok = false, count = 0) },
                ),
            )
        }

        run(Step.ROSTER, false) { src.roster() }
        var people = emptyList<String>()
        run(Step.DIRECTORY, false) { src.directory().also { people = it }.size }
        run(Step.MATCHES, !plan.matching) { src.matches() }
        var speakers = emptyList<String>()
        run(Step.TALKS, !plan.talks) { src.talks().also { speakers = it }.size }
        // Speakers too: the Talks list shows each one's name and picture.
        val profiled = (people + speakers).distinct()
        run(Step.PROFILES, profiled.isEmpty()) { src.profiles(profiled); profiled.size }
        run(Step.PICTURES, !plan.pictures) { prefetchPictures(src, src.pictureUrls(profiled)) }
        run(Step.PAGE, false) { src.page(); 1 }

        return OfflinePack(at = now(), steps = steps.toList(), mediaSkipped = true, bytesAdded = bytesAdded(before, runCatching { src.storageBytes() }.getOrNull()))
    }

    /**
     * Warm the pictures a few at a time. Fails only when every one failed: one
     * person's picture host being down must not mark the whole pack partial.
     */
    private suspend fun prefetchPictures(src: PackSources, urls: List<String>): Int {
        val wanted = urls.distinct().take(MAX_PICTURES)
        if (wanted.isEmpty()) return 0
        val gate = Semaphore(PICTURE_PARALLELISM)
        val ok = coroutineScope {
            wanted.map { u -> async { gate.withPermit { runCatching { src.prefetchImage(u) }.getOrDefault(false) } } }.awaitAll()
        }.count { it }
        if (ok == 0) throw java.io.IOException("no picture could be loaded")
        return ok
    }
}
