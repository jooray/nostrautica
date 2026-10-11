package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.join.JoinInput
import today.cypherpunk.nostrautica.domain.join.introMedia
import today.cypherpunk.nostrautica.domain.join.joinFlow
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Hierarchy
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.ParentProof
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.signer.silently

/**
 * Per-(owner, child) community state, in the owner-scoped cache so a logout takes it
 * with it (community-join.ts): the PROOF the child's grant carried, the CONSENT given
 * on the child's join form, "not now" on the offer card, and an index of children we
 * hold a proof for so a later scan can retry a join that failed (the grant that carried
 * the proof is memoized as processed and will not be seen again).
 *
 * Eviction fails safe: a lost consent is "unknown", which offers; it never joins.
 */
class CommunityStore(private val cache: Cache) {
    private fun proofKey(child: String) = "parentproof:$child"
    private fun consentKey(child: String) = "parentconsent:$child"

    suspend fun proofChildren(owner: String): List<String> = cache.get(owner, INDEX_KEY, ListSerializer(String.serializer())) ?: emptyList()

    suspend fun storeProof(owner: String, child: String, proof: StoredParentProof) {
        cache.put(owner, proofKey(child), StoredParentProof.serializer(), proof, nowSec())
        val rest = proofChildren(owner).filter { it != child }
        cache.put(owner, INDEX_KEY, ListSerializer(String.serializer()), (rest + child).takeLast(MAX_INDEXED), nowSec())
    }

    suspend fun proof(owner: String, child: String): StoredParentProof? = cache.get(owner, proofKey(child), StoredParentProof.serializer())

    /** The cache keeps the newest by `at`, so a later answer must carry a later `at`. */
    suspend fun recordConsent(owner: String, child: String, c: ParentConsent) {
        val prior = cache.getRaw(owner, consentKey(child))?.at ?: 0
        cache.put(owner, consentKey(child), ParentConsent.serializer(), c, maxOf(nowSec(), prior + 1))
    }

    suspend fun consent(owner: String, child: String): ParentConsent? = cache.get(owner, consentKey(child), ParentConsent.serializer())

    /** "Not now" on the offer card: keep the proof, stop asking. */
    suspend fun dismiss(owner: String, child: String) {
        val prior = consent(owner, child)
        val parent = prior?.parent ?: proof(owner, child)?.a ?: return
        recordConsent(owner, child, ParentConsent(parent, prior?.consent ?: false, prior?.name, dismissed = true))
    }

    companion object {
        const val INDEX_KEY = "parentproof:index"
        const val MAX_INDEXED = 200
    }
}

class CommunityOffer(val decision: CommunityJoinDecision, val proof: StoredParentProof? = null, val consent: ParentConsent? = null)

/**
 * Network side of the space hierarchy for ATTENDEES and shared reads (events/hierarchy.ts
 * and community-join.ts): link status, a child's view of its community, a community's
 * children, and joining a community because you joined one of its events. The organizer's
 * link/unlink and re-issue live in Organizer, which needs E_id.
 *
 * The one rule: nothing is sent to a community the person did not agree to.
 */
class Communities(private val c: AppContainer) {
    private val store get() = c.communityStore
    private val owner: String? get() = c.accounts.account?.pubkey

    // ── Config reads ────────────────────────────────────────────────────────

    /** The newest signed 31600 for a coordinate (always asks relays; falls back to what the store has). */
    suspend fun fetchNewestConfig(coordinate: String, relays: List<String> = emptyList()): EventConfig? = c.contexts.fetchConfig(coordinate, relays)

    /** An naddr for a coordinate: relay hints we have seen for it, else [extra]. Capped at two, like the rest of the app. */
    suspend fun naddrFor(coordinate: String, extra: List<String> = emptyList()): String =
        Coordinate.parse(coordinate).toNaddr((c.contexts.relayHints(coordinate) + extra).distinct().take(2))

    // Link status is asked once per approval and "Approve all" approves dozens in a row:
    // without a short memo that is one relay round-trip per attendee.
    private data class Memo(val parent: String?, val at: Long)
    private val linkMemo = HashMap<String, Memo>()

    fun clearLinkMemo() = synchronized(linkMemo) { linkMemo.clear() }

    /**
     * The community this event is linked to RIGHT NOW (both sides agree, §15.1), or null.
     * Fail-soft: a relay gap yields "no proof", never an error, because an approval must
     * not fail on account of an optional field.
     */
    suspend fun linkedParentFor(ctx: EventContext, fresh: Boolean = false): String? {
        val cfg = ctx.cfg
        val parent = cfg.parent ?: return null
        val hit = synchronized(linkMemo) { linkMemo[ctx.coordinate] }
        if (!fresh && hit != null && System.currentTimeMillis() - hit.at < LINK_TTL_MS) return hit.parent
        val linked = try {
            val parentCfg = fetchNewestConfig(parent, cfg.relays)
            if (parentCfg != null && Hierarchy.isLinked(parent, parentCfg, ctx.coordinate, cfg)) parent else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null // not memoized: try again on the next grant
        }
        synchronized(linkMemo) { linkMemo[ctx.coordinate] = Memo(linked, System.currentTimeMillis()) }
        return linked
    }

    /** The `parent` field for a 21602 an organizer client seals with E_id (§15.3); null when not linked. */
    suspend fun grantParentField(ctx: EventContext, eidSk: ByteArray, attendee: String, fresh: Boolean = false): ParentProof? {
        val parent = linkedParentFor(ctx, fresh) ?: return null
        val p = Hierarchy.makeProof(eidSk, parent, ctx.coordinate, attendee)
        return ParentProof(p.a, p.by, p.sig)
    }

    // ── A child event's view of its community ───────────────────────────────

    private fun toLinkedParent(child: EventContext, parentCtx: EventContext?): LinkedParent? {
        val parent = child.cfg.parent ?: return null
        if (parentCtx == null || parentCtx.coordinate != parent) return null
        if (!Hierarchy.isLinked(parent, parentCtx.cfg, child.coordinate, child.cfg)) return null
        return LinkedParent(parent, parentCtx.naddr, parentCtx.title, parentCtx.icon)
    }

    /** Cache only, for the first paint. */
    suspend fun cachedLinkedParent(child: EventContext): LinkedParent? {
        val parent = child.cfg.parent ?: return null
        return toLinkedParent(child, c.contexts.cached(naddrFor(parent, child.cfg.relays)))
    }

    /** The community this event is part of, or null. A parent tag nobody reciprocates is not a link (§15.1). Never throws. */
    suspend fun loadLinkedParent(child: EventContext): LinkedParent? {
        val parent = child.cfg.parent ?: return null
        return try {
            toLinkedParent(child, c.contexts.get(naddrFor(parent, child.cfg.relays)))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    // ── A community's children ──────────────────────────────────────────────

    private fun summaryOf(parent: String, child: String, ctx: EventContext?): ChildSummary? =
        ctx?.takeIf { it.cfg.parent == parent }?.let { ChildSummary(child, it.naddr, it.title, it.start, it.icon) }

    /** From the cache only: for the first paint of a community's Overview. */
    suspend fun cachedChildren(community: EventContext, now: Long = nowSec()): List<ChildSummary> =
        CommunityRules.sortChildren(
            community.cfg.children.mapNotNull { child -> summaryOf(community.coordinate, child, c.contexts.cached(naddrFor(child, community.cfg.relays))) },
            now,
        )

    /**
     * Load each child's public context (title, start) and sort them. A child that cannot be
     * loaded (relay gap, deleted) is skipped, and one that no longer names this community back
     * is dropped: the listing is a link, and a one-sided claim is not (§15.1).
     */
    suspend fun loadChildren(community: EventContext, now: Long = nowSec()): List<ChildSummary> = coroutineScope {
        community.cfg.children.map { child ->
            async {
                try {
                    summaryOf(community.coordinate, child, c.contexts.get(naddrFor(child, community.cfg.relays)))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
            }
        }.mapNotNull { it.await() }.let { CommunityRules.sortChildren(it, now) }
    }

    // ── Admin queue verification (§15.4) ────────────────────────────────────

    /** Of the join requests in a community's queue, which carry a `member_of` that verifies? attendee -> child. */
    suspend fun verifyQueueMembership(community: EventContext, requests: List<Pair<String, List<MemberOfClaim>>>): Map<String, String> {
        val parent = community.coordinate
        val parentCfg = fetchNewestConfig(parent, community.cfg.relays) ?: community.cfg
        val wanted = CommunityRules.claimedChildren(parentCfg, requests.map { it.second })
        val configs = HashMap<String, EventConfig?>()
        for (child in wanted) configs[child] = runCatching { fetchNewestConfig(child, parentCfg.relays) }.getOrNull()
        return CommunityRules.verifyQueue(parent, parentCfg, requests, configs)
    }

    // ── Attendee: consent, offer, join ──────────────────────────────────────

    suspend fun recordConsent(child: String, consent: ParentConsent) { owner?.let { store.recordConsent(it, child, consent) } }

    suspend fun dismissOffer(child: String) { owner?.let { store.dismiss(it, child) } }

    data class Standing(val isMember: Boolean, val isPending: Boolean)

    /** Whether this identity already belongs to, or is waiting on, a community. */
    fun standing(owner: String, parent: String): Standing =
        Standing(c.eventKeys.get(owner, parent)?.current != null, c.membership.joinSentAt(owner, parent) != null)

    /** What should happen about [child]'s community right now. */
    suspend fun evaluateOffer(child: String): CommunityOffer {
        val me = owner ?: return CommunityOffer(CommunityJoinDecision.NONE)
        val proof = store.proof(me, child)
        if (proof == null || !Hierarchy.isValidParent(proof.a)) return CommunityOffer(CommunityJoinDecision.NONE)
        val st = standing(me, proof.a)
        val applicable = CommunityRules.applicableConsent(proof, store.consent(me, child))
        return CommunityOffer(
            CommunityRules.decide(true, applicable?.consent, applicable?.dismissed == true, st.isMember, st.isPending),
            proof, applicable,
        )
    }

    private val inFlight = HashSet<String>()

    /**
     * Send the community join for [child]: a 21600 carrying `member_of`, a copy of the profile
     * given to the child as a 21601, and the community's own 31602 self-copy (all by
     * sendJoinRequest). The person's own signer seals it (§15.3). False when nothing was sent
     * (no proof, link since withdrawn, already in flight).
     */
    suspend fun joinViaChild(signer: NostrSigner, child: String, name: String? = null): Boolean {
        val me = signer.pubkey
        val proof = store.proof(me, child)?.takeIf { Hierarchy.isValidParent(it.a) } ?: return false
        val parent = proof.a
        if (!synchronized(inFlight) { inFlight.add(parent) }) return false
        try {
            val st = standing(me, parent)
            if (st.isMember || st.isPending) return false

            val relays = c.contexts.relayHints(child)
            val childCfg = fetchNewestConfig(child, relays)
            val parentCfg = fetchNewestConfig(parent, relays)
            // The link must still hold on both sides, or the community will queue the request
            // for a manual look instead of admitting it: say nothing rather than make a request
            // the person did not expect to be a manual one.
            if (childCfg == null || parentCfg == null || !Hierarchy.isLinked(parent, parentCfg, child, childCfg)) return false

            val parentCtx = c.contexts.get(naddrFor(parent, childCfg.relays))
            val childCtx = c.contexts.get(naddrFor(child, childCfg.relays))
            val bk = c.accounts.blindingKey()
            val self = runCatching { c.introMedia.loadSelfCopy(signer, childCtx, bk) }.getOrNull()
            val prior = store.consent(me, child)
            val joinName = name ?: prior?.name ?: c.profiles.local(me)?.name ?: ""

            c.joinFlow.sendJoinRequest(
                signer, parentCtx,
                JoinInput(name = joinName, profile = self?.profile, memberOf = MemberOfClaim(child, proof.by, proof.sig)),
                bk,
            )
            c.membership.markJoinSent(me, parent)
            // The same trail a join from the community's own page leaves, so Home lists it
            // as a pending space instead of the request vanishing into thin air.
            c.membership.noteOpened(me, parent, parentCtx.naddr)
            store.recordConsent(me, child, ParentConsent(parent, consent = true, name = joinName, dismissed = false))
            return true
        } finally {
            synchronized(inFlight) { inFlight.remove(parent) }
        }
    }

    /**
     * After a grant scan: for each child whose proof we hold, join the community if (and only
     * if) the person consented at the join form. Stored proofs are re-evaluated on EVERY scan,
     * so a join that failed offline retries. Never throws: it runs inside the grant scan.
     * Background scans pass [interactive] = false, and a remote signer is then never prompted.
     */
    suspend fun autoJoin(signer: NostrSigner, newChildren: Collection<String>, interactive: Boolean): List<String> {
        val me = signer.pubkey
        val joined = ArrayList<String>()
        for (child in (store.proofChildren(me) + newChildren).distinct()) {
            try {
                val offer = evaluateOffer(child)
                if (offer.decision != CommunityJoinDecision.JOIN) continue
                val sent = if (signer.isLocal || interactive) joinViaChild(signer, child) else silently { joinViaChild(signer, child) }
                if (sent) joined += offer.proof!!.a
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w("Communities", "automatic community join failed: ${e.javaClass.simpleName}")
            }
        }
        return joined
    }

    companion object {
        const val LINK_TTL_MS = 60_000L
    }
}
