package today.cypherpunk.nostrautica.domain.offline

import android.content.Context
import android.net.ConnectivityManager
import coil3.SingletonImageLoader
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.content.content
import today.cypherpunk.nostrautica.domain.people.observeMany
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.ui.components.safeImageSrc

/** The offline-pack service, created on first use. */
val AppContainer.offlinePacks: OfflinePacks get() = area("offline.packs") { OfflinePacks(this) }

/**
 * Runs [OfflinePackRules.build] against the real fetchers, only when the user taps
 * it (no background refresh), on the service's own scope so leaving the screen
 * doesn't abandon a half-built pack. The result is cached per owner, so the card
 * says "Ready to use offline" on the next visit with no network.
 */
class OfflinePacks(private val c: AppContainer) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val jobs = HashMap<String, Job>()
    private val _progress = MutableStateFlow<Map<String, List<PackStep>>>(emptyMap())

    /** Steps done so far, per coordinate, while a pack is being built (absent otherwise). */
    val progress: StateFlow<Map<String, List<PackStep>>> get() = _progress

    private fun key(coordinate: String) = "offlinepack:$coordinate"

    fun observe(owner: String, coordinate: String): Flow<OfflinePack?> =
        c.cache.observe(owner, key(coordinate), OfflinePack.serializer())

    /** The current network is metered (mobile data, a hotspot). */
    fun metered(): Boolean = runCatching {
        (c.context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered
    }.getOrDefault(false)

    /**
     * Start building the pack. False with no network: every fetcher would answer
     * from the phone and the pack would claim a readiness it never checked. A no-op
     * (true) while one is already running for this event.
     */
    fun start(ctx: EventContext, owner: String, signer: NostrSigner): Boolean = synchronized(jobs) {
        val coord = ctx.coordinate
        if (jobs[coord]?.isActive == true) return@synchronized true
        if (!c.nostr.network.value) return@synchronized false
        _progress.update { it + (coord to emptyList()) }
        jobs[coord] = scope.launch {
            try {
                val cfg = ctx.cfg
                val plan = PackPlan(
                    matching = cfg.coordinator != null && cfg.matching,
                    talks = cfg.talks != "off",
                    pictures = c.prefs.externalImages.value,
                )
                val pack = OfflinePackRules.build(plan, RealSources(ctx, owner, signer), { System.currentTimeMillis() / 1000 }) { steps ->
                    _progress.update { it + (coord to steps) }
                }
                c.cache.put(owner, key(coord), OfflinePack.serializer(), pack, pack.at)
            } finally {
                _progress.update { it - coord }
            }
        }
        true
    }

    private inner class RealSources(val ctx: EventContext, val owner: String, val signer: NostrSigner) : PackSources {
        private var roster: today.cypherpunk.nostrautica.protocol.RosterContent? = null

        override suspend fun roster(): Int {
            val r = c.members.fetchRoster(ctx, owner) ?: error("roster unreadable")
            roster = r
            return r.attendees.size
        }

        override suspend fun directory(): List<String> {
            val r = roster ?: c.members.cachedRoster(owner, ctx.coordinate) ?: error("no roster")
            return c.members.fetchDirectory(ctx, owner, r).map { it.pubkey }
        }

        override suspend fun matches(): Int = c.members.fetchMatches(ctx, signer)?.matches?.size ?: 0

        override suspend fun talks(): List<String> {
            val st = c.content.refreshTalks(ctx, owner, force = true) ?: error("no event key for talks")
            return st.items.map { it.talk.pubkey }
        }

        override suspend fun profiles(pubkeys: List<String>) {
            if (!c.profiles.refresh(pubkeys, force = true)) error("profiles unanswered")
        }

        override suspend fun pictureUrls(pubkeys: List<String>): List<String> {
            val pics = c.profiles.observeMany(pubkeys).first().values.mapNotNull { it.picture }
            return (listOf(ctx.icon, ctx.banner) + pics).mapNotNull { safeImageSrc(it, allowed = true) }
        }

        override suspend fun prefetchImage(url: String): Boolean {
            // Read once more per image: switching the setting off mid-pack stops the rest.
            if (!c.prefs.externalImages.value) return false
            val req = ImageRequest.Builder(c.context).data(url)
                .memoryCachePolicy(CachePolicy.DISABLED)
                .diskCachePolicy(CachePolicy.ENABLED)
                .size(THUMB_PX)
                .build()
            return SingletonImageLoader.get(c.context).execute(req) is SuccessResult
        }

        override suspend fun page() {
            if (!c.content.refresh(ctx, owner, force = true)) error("page unanswered")
        }

        override fun storageBytes(): Long? = runCatching {
            val db = c.context.getDatabasePath(DB_NAME)
            val files = listOf(db, java.io.File(db.path + "-wal"), java.io.File(db.path + "-shm"))
            files.sumOf { if (it.exists()) it.length() else 0L } + (SingletonImageLoader.get(c.context).diskCache?.size ?: 0L)
        }.getOrNull()
    }

    companion object {
        private const val DB_NAME = "nostrautica.db"
        private const val THUMB_PX = 256
    }
}
