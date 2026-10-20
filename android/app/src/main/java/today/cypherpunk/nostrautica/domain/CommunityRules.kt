package today.cypherpunk.nostrautica.domain

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Hierarchy
import today.cypherpunk.nostrautica.protocol.ParentProof

/** What a client should do about the community a child event's grant offered. */
enum class CommunityJoinDecision { JOIN, OFFER, NONE }

/** A membership proof as kept per child in the owner cache (community-join.ts StoredParentProof). */
@Serializable
data class StoredParentProof(val a: String, val by: String, val sig: String)

/** The answer given on the child's join form, and whether "Not now" was tapped later. */
@Serializable
data class ParentConsent(
    val parent: String,
    val consent: Boolean,
    val name: String? = null,
    val dismissed: Boolean = false,
)

/** A child event as a community lists it. [start] is unix seconds. */
data class ChildSummary(val coordinate: String, val naddr: String, val title: String, val start: Long? = null, val icon: String? = null)

/** A `member_of` claim as read off a join request. */
@Serializable
data class MemberOfClaim(val child: String, val by: String, val sig: String)

/** The community an event is (verifiably) part of, as the UI names it. */
data class LinkedParent(val coordinate: String, val naddr: String, val title: String, val icon: String? = null)

/**
 * Space hierarchy, pure rules (events/hierarchy.ts + community-join.ts): everything
 * the UI and the grant scan decide from state alone, so it can be tested without a
 * network and cannot drift between the screens that use it.
 */
object CommunityRules {
    /**
     * The rules of §15.5, in one place.
     *  - No proof, nothing to do. Already a member of / waiting on the community: nothing to do.
     *  - The person said yes at the join form: JOIN. The ONLY path that sends anything without a tap.
     *  - The person said no: leave them alone, never nag.
     *  - Never asked (joined before the feature, or a re-issued grant): OFFER as a one-tap card,
     *    unless they already answered "not now".
     */
    fun decide(hasProof: Boolean, consent: Boolean?, dismissed: Boolean = false, isMember: Boolean, isPending: Boolean): CommunityJoinDecision = when {
        !hasProof || isMember || isPending -> CommunityJoinDecision.NONE
        consent == true -> CommunityJoinDecision.JOIN
        consent == false -> CommunityJoinDecision.NONE
        dismissed -> CommunityJoinDecision.NONE
        else -> CommunityJoinDecision.OFFER
    }

    /**
     * A consent given for a different community than the proof names is not consent for
     * this one (the organizer re-pointed the event): unknown, which offers, never joins.
     */
    fun applicableConsent(proof: StoredParentProof, consent: ParentConsent?): ParentConsent? =
        consent?.takeIf { it.parent == proof.a }

    /**
     * Accept a proof from a received key grant (§15.3) iff it is for the community the
     * event's NEWEST config names and verifies as an authority's signature over THIS
     * attendee. The community re-checks it on its side.
     */
    fun acceptProof(child: String, proof: ParentProof?, config: EventConfig, attendee: String): StoredParentProof? {
        if (proof == null || config.parent != proof.a || !Hierarchy.isValidParent(proof.a)) return null
        if (!Hierarchy.verifyProof(proof.by, proof.sig, proof.a, child, attendee, Hierarchy.authorities(child, config))) return null
        return StoredParentProof(proof.a, proof.by, proof.sig)
    }

    /**
     * Upcoming first (soonest first), then past (most recent first). An event with no start
     * sorts after the upcoming ones and before the past: it is not known to be over. Ties
     * break on title, then coordinate, so the order is deterministic.
     */
    fun <T> sortChildren(list: List<T>, nowSec: Long, start: (T) -> Long?, title: (T) -> String, coordinate: (T) -> String): List<T> {
        fun rank(c: T): Int { val s = start(c); return if (s == null) 1 else if (s >= nowSec) 0 else 2 }
        // The PWA breaks ties with String.localeCompare (the runtime locale's collation);
        // a Collator for the device locale does the same here. String.compareTo is raw
        // UTF-16 order, which put "Banana" before "apple" (SB-81).
        val collator = java.text.Collator.getInstance()
        return list.sortedWith { a, b ->
            val ra = rank(a); val rb = rank(b)
            if (ra != rb) return@sortedWith ra.compareTo(rb)
            val sa = start(a); val sb = start(b)
            if (ra == 0 && sa != sb) return@sortedWith sa!!.compareTo(sb!!)
            if (ra == 2 && sa != sb) return@sortedWith sb!!.compareTo(sa!!)
            collator.compare(title(a), title(b)).takeIf { it != 0 } ?: collator.compare(coordinate(a), coordinate(b)).takeIf { it != 0 }
                ?: coordinate(a).compareTo(coordinate(b))
        }
    }

    fun sortChildren(list: List<ChildSummary>, nowSec: Long): List<ChildSummary> = sortChildren(list, nowSec, { it.start }, { it.title }, { it.coordinate })

    /** Upcoming (or undated) vs past, the two headings the community's Overview shows. */
    fun splitChildren(sorted: List<ChildSummary>, nowSec: Long): Pair<List<ChildSummary>, List<ChildSummary>> =
        sorted.partition { it.start == null || it.start >= nowSec }

    /**
     * Accept a `member_of` claim iff (§15.4) the two NEWEST configs link the spaces, `by` is an
     * authority of the child, and the signature verifies. [childCfg] is null when the child's
     * config could not be fetched: not verifiable.
     */
    fun verifyMemberOfClaim(parent: String, parentCfg: EventConfig, claim: MemberOfClaim, childCfg: EventConfig?, attendee: String): Boolean {
        if (childCfg == null) return false
        if (!Hierarchy.isLinked(parent, parentCfg, claim.child, childCfg)) return false
        return Hierarchy.verifyProof(claim.by, claim.sig, parent, claim.child, attendee, Hierarchy.authorities(claim.child, childCfg))
    }

    /** Which requests carry a claim that verifies: attendee pubkey -> the verified child. */
    fun verifyQueue(
        parent: String,
        parentCfg: EventConfig,
        requests: List<Pair<String, List<MemberOfClaim>>>,
        childConfigs: Map<String, EventConfig?>,
    ): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((attendee, claims) in requests) {
            for (claim in claims) {
                if (claim.child !in parentCfg.children) continue
                if (verifyMemberOfClaim(parent, parentCfg, claim, childConfigs[claim.child], attendee)) { out[attendee] = claim.child; break }
            }
        }
        return out
    }

    /** The children a queue's claims cite that the community actually lists: fetch each config once. */
    fun claimedChildren(parentCfg: EventConfig, claims: List<List<MemberOfClaim>>): Set<String> =
        claims.flatten().map { it.child }.filter { it in parentCfg.children }.toSet()

    /** Config changes for the link: the community's children list with [child] present or absent. */
    fun withChild(children: List<String>, child: String, present: Boolean): List<String> {
        val rest = children.filter { it != child }
        return if (present) rest + child else rest
    }
}
