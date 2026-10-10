package today.cypherpunk.nostrautica.domain.dm

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.nowSec

/** An event both people are on the roster of (DmChat.svelte "Also attending"). */
data class SharedEvent(val title: String, val naddr: String, val coordinate: String, val start: Long?, val end: Long?)

/** The per-event 30078 existed but could not be read: never write over it. */
class SettingsUnreadable : Exception("error.cat.decrypt")

/**
 * The thread header's context about the other person: which events you share,
 * and the per-event "want to meet" mark (events/settings.ts, the slice DmChat needs).
 */
object DmPeer {
    /**
     * Every event the user holds a working key for whose roster lists [peer].
     * Cache-first per event, falling through to a real fetch on a miss, so a cold
     * cache doesn't under-report. One bad event never blanks the list.
     */
    suspend fun sharedEvents(c: AppContainer, owner: String, peer: String): List<SharedEvent> = coroutineScope {
        c.eventKeys.list(owner).filter { it.eck.isNotEmpty() }.map { k ->
            async {
                runCatching {
                    val listed = c.members.cachedRoster(owner, k.coordinate)?.attendees?.any { it.pubkey == peer } == true
                    val ctx = c.contexts.forCoordinate(k.coordinate)
                    val onRoster = listed || c.members.fetchRoster(ctx, owner)?.attendees?.any { it.pubkey == peer } == true
                    if (onRoster) SharedEvent(ctx.title, ctx.naddr, ctx.coordinate, ctx.start, ctx.end) else null
                }.getOrNull()
            }
        }.awaitAll().filterNotNull()
    }

    /**
     * Which shared event the per-event actions act on: the soonest one that has not
     * ended (undated counts as live), else the most recently ended.
     */
    fun primary(events: List<SharedEvent>, now: Long = nowSec()): SharedEvent? {
        fun ended(e: SharedEvent) = (e.end ?: e.start)?.let { it < now } == true
        val live = events.filterNot(::ended)
        if (live.isNotEmpty()) return live.minByOrNull { it.start ?: 0 }
        return events.maxByOrNull { it.end ?: it.start ?: 0 }
    }

    private fun settingsKey(coordinate: String) = "evsettings:$coordinate"

    private suspend fun settingsD(c: AppContainer, ctx: EventContext, me: String) =
        "nostrautica:ev:" + ProtocolCrypto.blindedD(c.accounts.blindingKey(), ctx.coordinate, me)

    suspend fun cachedSettings(c: AppContainer, owner: String, coordinate: String): PerEventSettings? =
        c.cache.get(owner, settingsKey(coordinate), PerEventSettings.serializer())

    /**
     * The user's private settings for [ctx], or empty when none were ever saved.
     * Throws when one exists but can't be read — a writer must never treat that as empty.
     */
    suspend fun loadSettings(c: AppContainer, signer: NostrSigner, ctx: EventContext): PerEventSettings {
        val me = signer.pubkey
        val d = settingsD(c, ctx, me)
        c.nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(me), tags = mapOf("d" to listOf(d))))
        val latest = c.nostr.store.latest(Kinds.APP_DATA, me, d) ?: return PerEventSettings()
        val cached = c.cache.getRaw(me, settingsKey(ctx.coordinate))
        if (cached != null && cached.at >= latest.createdAt) cachedSettings(c, me, ctx.coordinate)?.let { return it }
        val json = signer.nip44Decrypt(me, latest.content)
        val s = (Wire.parseSafe(PerEventSettings.serializer(), json) as? Wire.Result.Ok)?.value ?: throw SettingsUnreadable()
        c.cache.put(me, settingsKey(ctx.coordinate), PerEventSettings.serializer(), s, latest.createdAt)
        return s
    }

    /** Toggle [peer] in want-to-meet for [ctx] (read-merge-write, monotonic). */
    suspend fun toggleWantToMeet(c: AppContainer, signer: NostrSigner, ctx: EventContext, peer: String): PerEventSettings {
        val me = signer.pubkey
        val current = loadSettings(c, signer, ctx)
        val list = if (peer in current.wantToMeet) current.wantToMeet - peer else current.wantToMeet + peer
        val next = current.copy(wantToMeet = list)
        val d = settingsD(c, ctx, me)
        val content = signer.nip44Encrypt(me, Wire.json.encodeToString(PerEventSettings.serializer(), next))
        val (ev, _) = c.accounts.signAndPublish(Kinds.APP_DATA, content, listOf(listOf("d", d)), Relays.DEFAULT, "settings")
        c.cache.put(me, settingsKey(ctx.coordinate), PerEventSettings.serializer(), next, ev.createdAt)
        return next
    }
}
