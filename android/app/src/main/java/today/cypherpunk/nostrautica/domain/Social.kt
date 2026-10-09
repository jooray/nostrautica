package today.cypherpunk.nostrautica.domain

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.jsonObjectOf

class FollowListGuard : Exception("error.followListGuard")

/**
 * The user's own public lists (events/nostr-actions.ts): kind 0, 10002, 10050 and
 * kind 3. Every write merges into the freshest copy from relays, never a blind
 * overwrite — a follow list republished from a failed read wipes someone's
 * whole social graph.
 */
class Social(private val nostr: Nostr, private val accounts: Accounts) {
    private suspend fun freshest(kind: Int, pubkey: String): NostrEvent? {
        nostr.fetch(Relays.READ, Filter(kinds = listOf(kind), authors = listOf(pubkey)))
        return nostr.store.latest(kind, pubkey)
    }

    /** Merge [edits] into the existing kind 0 (null values are left alone). */
    suspend fun publishProfile(edits: Map<String, String?>) {
        val pk = accounts.pubkey
        val existing = freshest(Kinds.PROFILE, pk)
        val base = LinkedHashMap((existing?.content?.let(::jsonObjectOf) ?: JsonObject(emptyMap())))
        edits.forEach { (k, v) -> if (v != null) base[k] = JsonPrimitive(v) }
        accounts.signAndPublish(Kinds.PROFILE, JsJson.stringify(JsonObject(base)), emptyList(), Relays.DEFAULT, "profile")
    }

    /** A 10002 for a new identity; never overrides an existing one. */
    suspend fun ensureRelayList(): Boolean {
        val pk = accounts.pubkey
        if (freshest(Kinds.RELAY_LIST, pk) != null) return false
        val tags = Relays.ONBOARDING.map { if (it.read && it.write) listOf("r", it.url) else listOf("r", it.url, if (it.read) "read" else "write") }
        accounts.signAndPublish(Kinds.RELAY_LIST, "", tags, Relays.DEFAULT, "relays")
        return true
    }

    /** A 10050 so people (and the coordinator) can reach the user's inbox. */
    suspend fun ensureDmRelayList(): Boolean {
        val pk = accounts.pubkey
        if (freshest(Kinds.DM_RELAY_LIST, pk) != null) return false
        accounts.signAndPublish(Kinds.DM_RELAY_LIST, "", Relays.DM_RELAY_LIST.map { listOf("relay", it) }, Relays.DEFAULT, "dm relays")
        return true
    }

    /** Onboarding a brand-new identity: name, optional picture, relay lists. */
    suspend fun onboard(name: String, picture: String? = null, about: String? = null) {
        publishProfile(mapOf("name" to name, "display_name" to name, "picture" to picture, "about" to about))
        runCatching { ensureRelayList() }
        runCatching { ensureDmRelayList() }
    }

    suspend fun followTags(): List<List<String>> = freshest(Kinds.CONTACTS, accounts.pubkey)?.tags ?: emptyList()

    suspend fun following(): Set<String> =
        (nostr.store.latest(Kinds.CONTACTS, accounts.pubkey)?.tags ?: emptyList()).filter { it.size >= 2 && it[0] == "p" }.map { it[1] }.toSet()

    suspend fun follow(target: String) {
        val existing = freshest(Kinds.CONTACTS, accounts.pubkey) ?: throw FollowListGuard()
        if (existing.tags.any { it.size >= 2 && it[0] == "p" && it[1] == target }) return
        accounts.signAndPublish(Kinds.CONTACTS, existing.content, existing.tags + listOf(listOf("p", target)), Relays.DEFAULT, "follow")
    }

    suspend fun unfollow(target: String) {
        val existing = freshest(Kinds.CONTACTS, accounts.pubkey) ?: throw FollowListGuard()
        val remaining = existing.tags.filterNot { it.size >= 2 && it[0] == "p" && it[1] == target }
        if (remaining.size == existing.tags.size) return
        accounts.signAndPublish(Kinds.CONTACTS, existing.content, remaining, Relays.DEFAULT, "unfollow")
    }

    data class FollowAllResult(val followed: List<String>, val alreadyFollowing: List<String>, val failed: List<String>)

    /** Follow many at once; refuses to publish onto a list that looks empty (unfetched). */
    suspend fun followAll(targets: List<String>): FollowAllResult {
        val existing = freshest(Kinds.CONTACTS, accounts.pubkey)
        val tags = existing?.tags ?: emptyList()
        val have = tags.filter { it.size >= 2 && it[0] == "p" }.map { it[1] }.toSet()
        val distinct = targets.distinct()
        val already = distinct.filter { it in have }
        val toAdd = distinct.filter { it !in have }
        if (toAdd.isEmpty()) return FollowAllResult(emptyList(), already, emptyList())
        if (have.isEmpty()) throw FollowListGuard()
        return runCatching {
            accounts.signAndPublish(Kinds.CONTACTS, existing?.content ?: "", tags + toAdd.map { listOf("p", it) }, Relays.DEFAULT, "follow")
            FollowAllResult(toAdd, already, emptyList())
        }.getOrElse { FollowAllResult(emptyList(), already, toAdd) }
    }

    /** A first follow (the event's identity) for someone with no follow list yet. */
    suspend fun seedFollows(eventPubkey: String) {
        val existing = freshest(Kinds.CONTACTS, accounts.pubkey)
        if (existing?.tags?.any { it.size >= 2 && it[0] == "p" } == true) return
        accounts.signAndPublish(Kinds.CONTACTS, "", listOf(listOf("p", eventPubkey)), Relays.DEFAULT, "follow")
    }
}
