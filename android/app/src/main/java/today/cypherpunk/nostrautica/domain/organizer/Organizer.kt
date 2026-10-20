package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.domain.Communities
import today.cypherpunk.nostrautica.domain.CommunityRules
import today.cypherpunk.nostrautica.domain.SerializableConfig
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.EventContexts
import today.cypherpunk.nostrautica.domain.EventKeys
import today.cypherpunk.nostrautica.domain.EventKeysStore
import today.cypherpunk.nostrautica.domain.Grants
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.domain.Profiles
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.AdminCommandContent
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.CoordinatorAnnounce
import today.cypherpunk.nostrautica.protocol.CoordinatorGrantContent
import today.cypherpunk.nostrautica.protocol.CoordinatorStatusContent
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.EckIdentity
import today.cypherpunk.nostrautica.protocol.KeysBackup
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Hierarchy
import today.cypherpunk.nostrautica.protocol.EventKeysBackup
import today.cypherpunk.nostrautica.protocol.GiftWrap
import today.cypherpunk.nostrautica.protocol.InviteEntry
import today.cypherpunk.nostrautica.protocol.InviteListContent
import today.cypherpunk.nostrautica.protocol.JoinRequestContent
import today.cypherpunk.nostrautica.protocol.KeyGrantContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.MyProfileContent
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.OrganizerGrantContent
import today.cypherpunk.nostrautica.protocol.ProfileSubmissionContent
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.RosterAttendee
import today.cypherpunk.nostrautica.protocol.RosterContent
import today.cypherpunk.nostrautica.protocol.Roster
import today.cypherpunk.nostrautica.protocol.Rumor
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.TalkContent
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.jsonObjectOf
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.ui.nav.Route

/** The organizer area's services, registered lazily from this file. */
val AppContainer.organizer: Organizer
    get() = area("organizer") {
        Organizer(nostr, cache, eventKeys, contexts, accounts, members, profiles, grants, communities, OrganizerBlossom(http, nostr, cache))
    }

class NotOrganizer(message: String = "organizer E_id key not available") : Exception(message)

/**
 * Organizer flows (events/create.ts, organizer.ts, coordinator-status.ts, recover.ts,
 * event-metadata.ts, event-page.ts, theme.ts, posts/updates publishing). Everything
 * E_id signs goes through here; the pure halves live in [OrganizerEvents],
 * [InboxFold], [Invites] and [AdminModel].
 *
 * Every whole-document republish (roster, invite list) refuses to run on a read it
 * could not establish — a lost read must never become "this event has one attendee".
 */
class Organizer(
    private val nostr: Nostr,
    private val cache: Cache,
    private val keyStore: EventKeysStore,
    private val contexts: EventContexts,
    private val accounts: Accounts,
    private val members: Members,
    private val profiles: Profiles,
    private val grants: Grants,
    private val communities: Communities,
    val blossom: OrganizerBlossom,
) {
    private val owner: String get() = accounts.pubkey
    private val locks = HashMap<String, Mutex>()
    private fun lock(k: String) = synchronized(locks) { locks.getOrPut(k) { Mutex() } }

    // ── Custody ─────────────────────────────────────────────────────────────

    fun keysFor(coordinate: String): EventKeys? = accounts.account?.let { keyStore.get(it.pubkey, coordinate) }

    fun isOrganizer(coordinate: String) = keysFor(coordinate)?.role == "organizer"

    private fun orgKeys(ctx: EventContext, needInbox: Boolean = false): EventKeys {
        val k = keysFor(ctx.coordinate)
        if (k == null || k.role != "organizer" || k.eidNsecHex == null) throw NotOrganizer()
        if (needInbox && k.einboxNsecHex == null) throw NotOrganizer("organizer keys not available on this device")
        return k
    }

    private fun eidSk(k: EventKeys) = Bytes.fromHex(k.eidNsecHex!!)

    private suspend fun saveKeys(k: EventKeys) = keyStore.save(owner, k)

    // ── Publishing helpers ──────────────────────────────────────────────────

    private suspend fun publish(ev: NostrEvent, relays: List<String>, label: String): Boolean =
        nostr.publish(ev, relays, owner, label) is Nostr.PublishResult.Published

    /**
     * nostr/monotonic.ts for E_id: read the current version, then sign at
     * max(now, previous + 1) under a per-address lock, so a same-second edit
     * never loses the §3.1 tie-break to the version it replaces.
     */
    private suspend fun publishMonotonic(
        eidSk: ByteArray, kind: Int, d: String?, relays: List<String>, label: String,
        build: (createdAt: Long) -> UnsignedEvent,
    ): Pair<NostrEvent, Boolean> {
        val eid = Secp.pubkeyHex(eidSk)
        return lock("mono:$kind:$eid:${d ?: ""}").withLock {
            runCatching {
                nostr.fetch(relays, Filter(kinds = listOf(kind), authors = listOf(eid), tags = d?.let { mapOf("d" to listOf(it)) } ?: emptyMap()), timeoutMs = 5_000)
            }
            val prev = nostr.store.latest(kind, eid, d)?.createdAt ?: 0
            val ev = build(maxOf(nowSec(), prev + 1)).signWith(eidSk)
            ev to publish(ev, relays, "k$kind")
        }
    }

    private suspend fun wrapFromEid(eidSk: ByteArray, recipient: String, kind: Int, content: String): NostrEvent {
        val signer = LocalSigner(eidSk)
        return GiftWrap.wrap(signer, recipient, GiftWrap.rumor(signer.pubkey, kind, content))
    }

    private suspend fun sendWrap(wrap: NostrEvent, recipient: String, ctx: EventContext, label: String): Boolean =
        accounts.publishWrapToAccount(wrap, recipient, ctx.relays, label) is Nostr.PublishResult.Published

    /** Re-read the context after an edit (the store already holds what we published). */
    suspend fun reload(naddr: String): EventContext {
        contexts.invalidate(naddr)
        return contexts.get(naddr, force = true)
    }

    // ── Create (create.ts) ──────────────────────────────────────────────────

    /** [linkFailed]: the event exists but the community did not list it back (Settings can finish the link). */
    data class CreateResult(val created: OrganizerEvents.Created, val naddr: String, val published: Boolean, val linkFailed: Boolean = false)

    suspend fun createEvent(input: CreateEventInput): CreateResult {
        val signer = accounts.signer
        val me = signer.pubkey
        val bk = accounts.blindingKey()
        val c = OrganizerEvents.buildCreate(input)
        // Custody first: if the app dies mid-publish, the outbox still holds the
        // events and this device still holds the keys that signed them.
        keyStore.save(me, EventKeys(c.coordinate, "organizer", listOf(c.eck), c.eidNsecHex, c.einboxNsecHex))
        val backupContent = signer.nip44Encrypt(me, Wire.encode(EventKeysBackup.serializer(), c.backup))
        val backupD = "nostrautica:eventkeys:" + ProtocolCrypto.blindedD(bk, c.coordinate, me)
        val relays = c.config.relays
        val results = coroutineScope {
            listOf(
                async { publish(c.kind0, relays, "event") },
                async { publish(c.space, relays, "event") },
                async { publish(c.configEvent, relays, "event") },
                async { accounts.signAndPublish(Kinds.APP_DATA, backupContent, listOf(listOf("d", backupD)), Relays.DEFAULT, "eventkeys").second is Nostr.PublishResult.Published },
            ).awaitAll()
        }
        runCatching { contexts.get(c.naddr, force = true) }
        // §15.1: the community must list the event back or the link does not exist. Best-effort
        // like enrollment: the event exists either way, and Settings can finish the link.
        val linkFailed = input.parent != null && !input.community &&
            runCatching { setCommunityChild(input.parent, c.coordinate, true, relays) }.isFailure
        return CreateResult(c, c.naddr, results.all { it }, linkFailed)
    }

    /**
     * create.ts enrollOrganizerAsParticipant: a real invite-backed 21600 (so a later
     * coordinator backfill auto-approves it) plus an immediate self-approval signed by
     * E_id, roster role "organizer".
     */
    suspend fun enrollSelf(ctx: EventContext) {
        val signer = accounts.signer
        val me = signer.pubkey
        runCatching { profiles.refresh(listOf(me)) }
        val p = profiles.local(me)
        val name = p?.name ?: ""
        val profile = AttendeeProfile(about = p?.about ?: "")
        val invite = generateInvites(ctx, 1, "organizer-self").firstOrNull()
        sendJoinRequest(ctx, name, profile, invite?.nsec)
        // With a coordinator attached it approves the join via the invite; a client
        // self-approval would be a second roster author (SB-91).
        try {
            approve(ctx, PendingRequest(me, name, profile = profile, rumorCreatedAt = nowSec()), "organizer")
        } catch (_: CoordinatorAttached) {}
    }

    /** join.ts sendJoinRequest, as the organizer's own account (21600 + 21601 + 31602 self-copy). */
    private suspend fun sendJoinRequest(ctx: EventContext, name: String, profile: AttendeeProfile, inviteNsec: String?) {
        val signer = accounts.signer
        val me = signer.pubkey
        val cfg = ctx.cfg
        val tags = mutableListOf(listOf("a", ctx.coordinate))
        if (inviteNsec != null) {
            val proof = ProtocolCrypto.makeInviteProof(Nip19.decodeNsec(inviteNsec), ctx.coordinate, me)
            tags += listOf("invite", proof.invitePubkey, proof.sig)
        }
        val join = Wire.encode(JoinRequestContent.serializer(), JoinRequestContent(name = name.take(Limits.MAX_NAME)))
        val bk = accounts.blindingKey()
        val selfD = ProtocolCrypto.blindedD(bk, ctx.coordinate, me)
        val prevRev = nostr.store.latest(Kinds.MY_PROFILE, me, selfD)?.let { e ->
            runCatching { Wire.parse(MyProfileContent.serializer(), signer.nip44Decrypt(me, e.content)).rev }.getOrNull()
        }
        val rev = (prevRev ?: -1) + 1
        val sub = Wire.encode(ProfileSubmissionContent.serializer(), ProfileSubmissionContent(rev = rev, profile = profile))
        val self = Wire.encode(MyProfileContent.serializer(), MyProfileContent(a = ctx.coordinate, profile = profile, rev = rev))
        val w1 = GiftWrap.wrap(signer, cfg.inbox, GiftWrap.rumor(me, Kinds.JOIN_REQUEST, join, tags))
        val w2 = GiftWrap.wrap(signer, cfg.inbox, GiftWrap.rumor(me, Kinds.PROFILE_SUBMISSION, sub, listOf(listOf("a", ctx.coordinate))))
        publish(w1, ctx.relays, "join")
        publish(w2, ctx.relays, "join")
        accounts.signAndPublish(Kinds.MY_PROFILE, signer.nip44Encrypt(me, self), listOf(listOf("d", selfD)), Relays.DEFAULT, "selfcopy")
    }

    // ── The E_inbox queue (organizer.ts fetchPending, talks.ts fetchPendingTalks) ──

    private val rumorMemo = HashMap<String, Rumor?>()

    private fun inboxSecrets(k: EventKeys): List<ByteArray> =
        (listOfNotNull(k.einboxNsecHex) + (k.priorEinboxNsecs ?: emptyList())).distinct().map(Bytes::fromHex)

    fun inboxPubkeys(k: EventKeys): List<String> = inboxSecrets(k).map(Secp::pubkeyHex)

    private fun unwrapInbox(wrap: NostrEvent, sks: List<ByteArray>): Rumor? = synchronized(rumorMemo) {
        if (rumorMemo.containsKey(wrap.id)) return rumorMemo[wrap.id]
        val r = sks.firstNotNullOfOrNull { sk -> runCatching { GiftWrap.unwrapLocal(wrap, sk, Kinds.EVENT_INBOX_RUMOR_KINDS) }.getOrNull() }
        rumorMemo[wrap.id] = r
        r
    }

    data class Inbox(val pending: List<PendingRequest>, val talks: List<PendingTalk>?)

    /**
     * Read every wrap sealed to the current AND prior inboxes (NIP §3.7) inside the
     * gift-wrap window, straight from relays, and fold it. One read feeds both the
     * join queue and the talk-moderation queue.
     */
    suspend fun readInbox(ctx: EventContext, keys: EventKeys): Inbox {
        val sks = inboxSecrets(keys)
        if (sks.isEmpty()) throw NotOrganizer("missing E_inbox key")
        if (!nostr.network.value) throw java.io.IOException("offline")
        val r = nostr.pool.fetch(
            ctx.relays,
            listOf(Filter(kinds = listOf(Kinds.GIFT_WRAP), tags = mapOf("p" to sks.map(Secp::pubkeyHex)), since = GiftWrap.since())),
            timeoutMs = 10_000, graceMs = 2_000,
        )
        val rumors = r.events.mapNotNull { unwrapInbox(it, sks) }
        val pending = InboxFold.fold(rumors, ctx.coordinate)
        cache.put(owner, "pending:${ctx.coordinate}", ListSerializer(PendingRequest.serializer()), pending, pending.maxOfOrNull { it.rumorCreatedAt } ?: 0)
        val cfg = ctx.cfg
        val talks = if (cfg.talks != "off" && cfg.coordinator != null) {
            val published = runCatching { publishedTalkRevisions(ctx, keys) }.getOrDefault(emptyMap())
            InboxFold.pendingTalks(rumors, ctx.coordinate, published).also {
                cache.put(owner, "pendingtalks:${ctx.coordinate}", ListSerializer(PendingTalk.serializer()), it, it.maxOfOrNull { t -> t.rumorCreatedAt } ?: 0)
            }
        } else null
        return Inbox(pending, talks)
    }

    suspend fun cachedPending(coordinate: String) = cache.get(owner, "pending:$coordinate", ListSerializer(PendingRequest.serializer())) ?: emptyList()
    suspend fun cachedPendingTalks(coordinate: String) = cache.get(owner, "pendingtalks:$coordinate", ListSerializer(PendingTalk.serializer())) ?: emptyList()

    /**
     * A live 1059 subscription to the inboxes while Admin is visible (replaces the
     * PWA's 30 s poll). Wraps are backdated up to two days (NIP-59), so the filter
     * must reach back that far; wraps already read by [readInbox] don't re-trigger.
     */
    fun liveInbox(ctx: EventContext, keys: EventKeys): Flow<Unit> =
        nostr.pool.subscribe(ctx.relays, listOf(Filter(kinds = listOf(Kinds.GIFT_WRAP), tags = mapOf("p" to inboxPubkeys(keys)), since = GiftWrap.since())))
            .filterIsInstance<RelayPool.Message.Event>()
            .filter { m -> synchronized(rumorMemo) { !rumorMemo.containsKey(m.event.id) } }
            .map { }

    /** Newest published revision per (speaker, talk_d) among the 31610s this event published. */
    private suspend fun publishedTalkRevisions(ctx: EventContext, keys: EventKeys): Map<String, Long> {
        val cfg = ctx.cfg
        val publisher = cfg.coordinator ?: cfg.eidPubkey
        val f = Filter(kinds = listOf(Kinds.TALK), authors = listOf(publisher), tags = mapOf("a" to listOf(ctx.coordinate)))
        nostr.fetch(ctx.relays, f)
        val out = HashMap<String, Long>()
        for (e in nostr.store.query(f).groupBy { it.d }.mapNotNull { Ordering.pickLatest(it.value) }) {
            val eck = keys.eckFor(e.tag("eck")?.toIntOrNull()) ?: keys.current?.bytes() ?: continue
            val t = runCatching { Wire.parse(TalkContent.serializer(), Nip44.eckDecrypt(eck, e.content)) }.getOrNull() ?: continue
            if (t.status != "published") continue
            val k = "${t.pubkey}:${t.talkD}"
            out[k] = maxOf(out[k] ?: -1, t.revision)
        }
        return out
    }

    // ── Roster read for a rewrite (organizer.ts loadRoster) ──────────────────

    private suspend fun seen(what: String, coordinate: String) = cache.getRaw(owner, "published:$what:$coordinate") != null
    private suspend fun markSeen(what: String, coordinate: String) =
        cache.put(owner, "published:$what:$coordinate", Long.serializer(), nowSec(), nowSec())

    /**
     * The current roster, or why it can't be established. "Nothing came back" is a
     * first roster only if no relay answered nothing AND this device never saw one.
     */
    suspend fun loadRoster(ctx: EventContext, keys: EventKeys): OrganizerEvents.RosterRead {
        val cfg = ctx.cfg
        val publisher = cfg.coordinator ?: cfg.eidPubkey
        val accepted = listOfNotNull(cfg.coordinator, cfg.eidPubkey)
        val id = ctx.coord.identifier
        val r = nostr.pool.fetch(ctx.relays, listOf(Filter(kinds = listOf(Kinds.ROSTER), authors = listOf(publisher), tags = mapOf("d" to listOf(id)))), timeoutMs = 10_000, graceMs = 2_000)
        nostr.store.put(r.events)
        val latest = nostr.store.latest(Kinds.ROSTER, publisher, id)?.takeIf { it.pubkey in accepted }
        if (latest == null) return OrganizerEvents.RosterRead.Absent(suspect = seen("roster", ctx.coordinate))
        var at = latest.createdAt
        // The key the roster's own `eck` tag names, from EVERY version held, staged
        // ones included (DS41-002, NIP §4.1).
        val all = EckIdentity.union(keys.eck, keys.pendingEck ?: emptyList())
        val ref = EckIdentity.readTag(latest.tags)
        val candidates = if (ref != null) EckIdentity.candidates(all, ref) else listOfNotNull(keys.current)
        if (ref != null && (candidates.isEmpty() || ref.id > (all.maxOfOrNull { it.id } ?: 0))) return OrganizerEvents.RosterRead.Foreign(at)
        fun decWith(v: EckVersion, e: NostrEvent): RosterContent? =
            (runCatching { Wire.parseSafe(RosterContent.serializer(), Nip44.eckDecrypt(v.bytes(), e.content)) }.getOrNull() as? Wire.Result.Ok)?.value
        var used: EckVersion? = null
        var page0: RosterContent? = null
        for (v in candidates) { page0 = decWith(v, latest); if (page0 != null) { used = v; break } }
        if (page0 == null || used == null) return OrganizerEvents.RosterRead.Unreadable(at)
        fun dec(e: NostrEvent): RosterContent? = decWith(used, e)
        var roster = page0
        val pages = Roster.pageCountOf(page0)
        if (pages > 1) {
            val ds = Roster.continuationDs(id, pages)
            nostr.store.put(nostr.pool.fetch(ctx.relays, listOf(Filter(kinds = listOf(Kinds.ROSTER), authors = listOf(latest.pubkey), tags = mapOf("d" to ds))), timeoutMs = 10_000, graceMs = 2_000).events)
            val rest = ds.map { d ->
                val e = nostr.store.latest(Kinds.ROSTER, latest.pubkey, d)?.takeIf { it.tag("a") == ctx.coordinate } ?: return OrganizerEvents.RosterRead.Unreadable(at)
                at = maxOf(at, e.createdAt)
                dec(e) ?: return OrganizerEvents.RosterRead.Unreadable(at)
            }
            roster = Roster.merge(listOf(page0) + rest)
        }
        markSeen("roster", ctx.coordinate)
        promotePending(ctx.coordinate, used)
        return OrganizerEvents.RosterRead.Ok(roster, at, used)
    }

    /** The roster is under a staged version: its rotation did publish, so it is current now (DS41-002). */
    private suspend fun promotePending(coordinate: String, used: EckVersion) {
        val k = keysFor(coordinate) ?: return
        val pending = k.pendingEck ?: return
        if (pending.none { it.id == used.id && it.key == used.key }) return
        val eck = EckIdentity.union(k.eck, pending.filter { it.id <= used.id })
        saveKeys(k.copy(eck = eck, pendingEck = EventKeys.pendingMinus(pending, eck)))
    }

    /** Persist a freshly minted version as staged, not current (DS41-002). */
    private suspend fun stageEck(keys: EventKeys, v: EckVersion): EventKeys =
        keys.copy(pendingEck = EckIdentity.union(keys.pendingEck ?: emptyList(), listOf(v))).also { saveKeys(it) }

    private fun assertNoEckCollision(keys: EventKeys) {
        val cur = keys.current ?: return
        if (cur.id in EckIdentity.collisionIds(keys.eck)) throw OrganizerEvents.EckCollision()
    }

    // ── Approve (organizer.ts approveAttendee) ──────────────────────────────

    suspend fun approve(ctx: EventContext, req: PendingRequest, role: String = "attendee") = lock("roster:${ctx.coordinate}").withLock {
        // One roster author (SB-91): with a coordinator attached this is a 21604.
        assertNoCoordinatorAuthority(ctx)
        val keys0 = orgKeys(ctx)
        keys0.current ?: throw IllegalStateException("no ECK available")
        // Roster first, with every version held (DS41-002): it may promote a staged
        // version, and a roster under a key this device lacks refuses here (SB-90).
        val read = loadRoster(ctx, keys0)
        val keys = keysFor(ctx.coordinate) ?: keys0
        assertNoEckCollision(keys)
        // Written under the key the live roster is under, so every entry on it agrees.
        val eck = (read as? OrganizerEvents.RosterRead.Ok)?.eck ?: keys.current!!
        val eidSk = eidSk(keys)
        val eid = Secp.pubkeyHex(eidSk)
        val eckBytes = eck.bytes()
        val grant = Wire.encode(KeyGrantContent.serializer(), KeyGrantContent(a = ctx.coordinate, role = role, eck = keys.eck, grantedBy = eid, parent = communities.grantParentField(ctx, eidSk, req.attendeePubkey)))
        val grantWrap = wrapFromEid(eidSk, req.attendeePubkey, Kinds.KEY_GRANT, grant)
        val entryD = ProtocolCrypto.blindedD(eckBytes, ctx.coordinate, req.attendeePubkey)
        val now = nowSec()
        val entry = DirectoryEntryContent(
            pubkey = req.attendeePubkey, name = req.name.ifEmpty { null }, profile = req.profile ?: AttendeeProfile(),
            media = req.media ?: emptyList(), introText = req.introText, updatedAt = now,
        )
        val entryEvent = UnsignedEvent(
            eid, now, Kinds.DIRECTORY_ENTRY,
            listOf(listOf("d", entryD), listOf("a", ctx.coordinate), EckIdentity.tag(eck), listOf("v", "2")),
            Nip44.eckEncrypt(eckBytes, Wire.encode(DirectoryEntryContent.serializer(), entry)),
        ).signWith(eidSk)
        val (roster, at) = OrganizerEvents.rosterForRewrite(read, eck.id)
        val previous = roster
        val next = if (roster.attendees.any { it.pubkey == req.attendeePubkey }) roster
        else roster.copy(attendees = roster.attendees + RosterAttendee(req.attendeePubkey, entryD, role))
        if (next.attendees.size > Limits.MAX_ROSTER) {
            throw IllegalStateException("This event's roster is full (${Limits.MAX_ROSTER} members). Remove someone before approving anyone else.")
        }
        val rosterEvents = OrganizerEvents.buildRosterEvents(ctx.coordinate, eidSk, eckBytes, eck.id, next, at, previous)
        markSeen("roster", ctx.coordinate)
        coroutineScope {
            (listOf(async { sendWrap(grantWrap, req.attendeePubkey, ctx, "grant") }, async { publish(entryEvent, ctx.relays, "directory") }) +
                rosterEvents.map { async { publish(it, ctx.relays, "roster") } }).awaitAll()
        }
        Unit
    }

    // ── Space hierarchy (events/hierarchy.ts, §15) ──────────────────────────

    private fun cfgOf(ctx: EventContext, cfg: EventConfig) = ctx.copy(config = SerializableConfig(cfg.eidPubkey, OrganizerEvents.configTags(cfg)))

    /**
     * Republish a space's own 31600 with [mutate] applied to the NEWEST config. The read is
     * fresh from relays: a republish built on a cached config would silently drop whatever
     * another device changed since. Null when nothing would change.
     */
    private suspend fun republishConfig(coordinate: String, relays: List<String>, mutate: (EventConfig) -> EventConfig): EventConfig? {
        val keys = keysFor(coordinate)
        if (keys == null || keys.role != "organizer" || keys.eidNsecHex == null) throw NotOrganizer()
        val current = contexts.fetchConfig(coordinate, relays) ?: throw IllegalStateException("Event config (31600) not found")
        val next = mutate(current)
        if (next.children == current.children && next.parent == current.parent) return null
        val publishRelays = (OrganizerEvents.unionRelays(relays, current.relays) + Relays.DEFAULT).distinct()
        publishMonotonic(eidSk(keys), Kinds.EVENT_CONFIG, next.d, publishRelays, "config") { at ->
            UnsignedEvent(next.eidPubkey, at, Kinds.EVENT_CONFIG, OrganizerEvents.configTags(next), "")
        }
        communities.clearLinkMemo()
        runCatching { contexts.invalidate(communities.naddrFor(coordinate, current.relays)) }
        return next
    }

    /** Add (or remove) a child on the community's 31600. Needs the community's E_id. */
    suspend fun setCommunityChild(community: String, child: String, present: Boolean, relays: List<String> = emptyList()): EventConfig? {
        require(Hierarchy.isValidParent(community)) { "not a community" }
        return republishConfig(community, relays) { cfg ->
            cfg.copy(children = CommunityRules.withChild(cfg.children, child, present))
        }
    }

    /** Set (or clear) the parent on the event's own 31600. Needs the event's E_id. */
    suspend fun setEventParent(ctx: EventContext, parent: String?): EventConfig? {
        val out = republishConfig(ctx.coordinate, ctx.cfg.relays) { cfg -> cfg.copy(parent = parent) }
        runCatching { contexts.invalidate(ctx.naddr) }
        return out
    }

    /** Communities whose E_id this device holds, with titles, for a picker. Best effort per entry. */
    suspend fun listOrganizedCommunities(): List<EventContext> =
        keyStore.list(owner)
            .filter { it.role == "organizer" && it.eidNsecHex != null && Coordinate.parseOrNull(it.coordinate)?.isCommunity == true }
            .mapNotNull { k -> runCatching { contexts.forCoordinate(k.coordinate) }.getOrNull() }
            .sortedBy { it.title.lowercase() }

    /**
     * Link [child] to [community] (§15.1): the community lists it, then the event names the
     * community. In that order, so there is never a moment where the event advertises a
     * community that has not agreed. For an event with no coordinator, everyone already
     * approved gets a fresh grant carrying the proof (§15.3); with a coordinator the
     * coordinator holds the roster and the grant path. Returns how many were re-sent.
     */
    suspend fun linkEventToCommunity(child: EventContext, community: EventContext): Int {
        setCommunityChild(community.coordinate, child.coordinate, true, community.cfg.relays)
        val cfg = setEventParent(child, community.coordinate)
        if (child.cfg.coordinator != null) return 0
        return runCatching { reissueGrantsWithProof(cfgOf(child, cfg ?: child.cfg.copy(parent = community.coordinate))) }.getOrDefault(0)
    }

    /**
     * End the link from the event's side, and from the community's too when this device
     * organizes it. Memberships already granted are not revoked (§15.1).
     */
    suspend fun unlinkEventFromCommunity(child: EventContext) {
        val parent = child.cfg.parent
        setEventParent(child, null)
        if (parent == null) return
        val keys = keysFor(parent)
        if (keys?.role == "organizer" && keys.eidNsecHex != null) runCatching { setCommunityChild(parent, child.coordinate, false) }
    }

    /**
     * Re-issue a key grant carrying the community membership proof to everyone already approved
     * (§15.3). Run once when an organizer links an event that has no coordinator: people who joined
     * before the link would otherwise never be offered the community. The grant is the same ECK set
     * they already hold (receivers union-merge, §6.3), plus the proof. 0 when the roster cannot be
     * read or the event is not linked.
     */
    suspend fun reissueGrantsWithProof(ctx: EventContext): Int {
        val keys = keysFor(ctx.coordinate)
        if (keys == null || keys.role != "organizer" || keys.eidNsecHex == null || keys.current == null) return 0
        val eidSk = eidSk(keys)
        val read = loadRoster(ctx, keys) as? OrganizerEvents.RosterRead.Ok ?: return 0
        var sent = 0
        for (a in read.roster.attendees) {
            // Not linked (yet): nothing to send to anyone.
            val proof = communities.grantParentField(ctx, eidSk, a.pubkey, fresh = sent == 0) ?: return sent
            val grant = Wire.encode(KeyGrantContent.serializer(), KeyGrantContent(a = ctx.coordinate, role = a.role, eck = keys.eck, grantedBy = Secp.pubkeyHex(eidSk), parent = proof))
            sendWrap(wrapFromEid(eidSk, a.pubkey, Kinds.KEY_GRANT, grant), a.pubkey, ctx, "grant")
            sent++
        }
        return sent
    }

    // ── Revoke and rotation (organizer.ts revokeAttendeeClient / rotateEckAndInbox) ──

    private suspend fun directoryContents(ctx: EventContext, ds: List<String>, prev: EckVersion, held: List<EckVersion>): Map<String, String> {
        val cfg = ctx.cfg
        val publisher = cfg.coordinator ?: cfg.eidPubkey
        ds.chunked(Members.D_CHUNK).forEach { chunk ->
            runCatching { nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.DIRECTORY_ENTRY), authors = listOf(publisher), tags = mapOf("d" to chunk))) }
        }
        return ds.mapNotNull { d ->
            val e = nostr.store.latest(Kinds.DIRECTORY_ENTRY, publisher, d) ?: return@mapNotNull null
            // The key the entry's own tag names, then the roster's (NIP §4.1).
            val keys = (EckIdentity.readTag(e.tags)?.let { EckIdentity.candidates(held, it) } ?: emptyList()) + prev
            keys.firstNotNullOfOrNull { k -> runCatching { Nip44.eckDecrypt(k.bytes(), e.content) }.getOrNull() }?.let { d to it }
        }.toMap()
    }

    private data class Rotation(val events: List<NostrEvent>, val grants: List<Pair<String, NostrEvent>>)

    /** Re-encrypt [remaining]'s entries under the new ECK, re-grant everyone, rebuild the roster. */
    private suspend fun rotateFor(ctx: EventContext, eidSk: ByteArray, prev: EckVersion, next: EckVersion, eckAll: List<EckVersion>, remaining: List<RosterAttendee>, rosterAt: Long, nostrGroupId: String?, held: List<EckVersion>): Rotation {
        val eid = Secp.pubkeyHex(eidSk)
        val newBytes = next.bytes()
        val plain = directoryContents(ctx, remaining.map { it.d }, prev, held)
        val events = mutableListOf<NostrEvent>()
        val grantWraps = mutableListOf<Pair<String, NostrEvent>>()
        val newRoster = OrganizerEvents.rederive(ctx.coordinate, remaining, newBytes)
        for ((a, re) in remaining.zip(newRoster)) {
            val newD = re.d
            plain[a.d]?.let { json ->
                events += UnsignedEvent(eid, nowSec(), Kinds.DIRECTORY_ENTRY,
                    listOf(listOf("d", newD), listOf("a", ctx.coordinate), EckIdentity.tag(next), listOf("v", "2")),
                    Nip44.eckEncrypt(newBytes, json)).signWith(eidSk)
            }
            val grant = Wire.encode(KeyGrantContent.serializer(), KeyGrantContent(a = ctx.coordinate, role = a.role, eck = eckAll, grantedBy = eid, parent = communities.grantParentField(ctx, eidSk, a.pubkey)))
            grantWraps += a.pubkey to wrapFromEid(eidSk, a.pubkey, Kinds.KEY_GRANT, grant)
        }
        events += OrganizerEvents.buildRosterEvents(ctx.coordinate, eidSk, newBytes, next.id, RosterContent(2, next.id, nostrGroupId, null, newRoster), rosterAt)
        return Rotation(events, grantWraps)
    }

    private suspend fun publishRotation(ctx: EventContext, rot: Rotation, extra: List<NostrEvent> = emptyList()) = coroutineScope {
        markSeen("roster", ctx.coordinate)
        ((rot.events + extra).map { async { publish(it, ctx.relays, "rotation") } } +
            rot.grants.map { (pk, w) -> async { sendWrap(w, pk, ctx, "grant") } }).awaitAll()
    }

    /** One past every id held, staged ones included, so an interrupted rotation's id is never reused. */
    private fun newEckVersion(k: EventKeys) = OrganizerEvents.nextEck(k.eck + (k.pendingEck ?: emptyList()), ProtocolCrypto.generateEck())

    /** Revoke without a coordinator: forward-only ECK rotation, everyone else re-granted. */
    suspend fun revokeClient(ctx: EventContext, removed: String) = lock("roster:${ctx.coordinate}").withLock {
        // One roster author (SB-91): with a coordinator attached the coordinator rotates.
        assertNoCoordinatorAuthority(ctx)
        val keys0 = orgKeys(ctx)
        val eidSk = eidSk(keys0)
        keys0.current ?: throw IllegalStateException("no ECK available")
        // Read BEFORE minting: an aborted revoke must leave custody untouched.
        val read = loadRoster(ctx, keys0)
        val keys = keysFor(ctx.coordinate) ?: keys0
        val prev = (read as? OrganizerEvents.RosterRead.Ok)?.eck ?: keys.current!!
        val (roster, at) = OrganizerEvents.rosterForRewrite(read, prev.id)
        if (roster.attendees.none { it.pubkey == removed }) {
            throw IllegalStateException("That attendee isn't on the roster we just read, so nothing was published. Reload the People list and try again.")
        }
        val removedD = roster.attendees.first { it.pubkey == removed }.d
        val deletion = UnsignedEvent(Secp.pubkeyHex(eidSk), nowSec(), Kinds.DELETION,
            listOf(listOf("a", "${Kinds.DIRECTORY_ENTRY}:${ctx.cfg.eidPubkey}:$removedD"), listOf("k", Kinds.DIRECTORY_ENTRY.toString())), "revoked").signWith(eidSk)
        val next = newEckVersion(keys)
        val eckAll = EckIdentity.union(keys.eck, listOf(next))
        // Build everything first, then stage the key (persisted, not current), back
        // it up, publish, and only then make it current (DS41-002).
        val rot = rotateFor(ctx, eidSk, prev, next, eckAll, roster.attendees.filter { it.pubkey != removed }, at, roster.nostrGroupId,
            EckIdentity.union(keys.eck, keys.pendingEck ?: emptyList()))
        val staged = stageEck(keys, next)
        // The rotated ECK must reach the durable backup, or a fresh device restores v1 only.
        runCatching { writeBackup(ctx.coordinate, staged, staged.coordinatorGen ?: 0) }
        publishRotation(ctx, rot, listOf(deletion))
        promotePending(ctx.coordinate, next)
        reissueOrganizerGrants(ctx, ctx.coordinate)
    }

    /** Detach/replace (NIP §3.7): rotate the ECK AND E_inbox; the old inbox is kept for history. */
    private suspend fun rotateEckAndInbox(ctx: EventContext, keys0: EventKeys): EventKeys {
        val eidSk = eidSk(keys0)
        keys0.current ?: throw IllegalStateException("no ECK available")
        val read = loadRoster(ctx, keys0)
        val keys = keysFor(ctx.coordinate) ?: keys0
        val prev = (read as? OrganizerEvents.RosterRead.Ok)?.eck ?: keys.current!!
        val (roster, at) = OrganizerEvents.rosterForRewrite(read, prev.id)
        val next = newEckVersion(keys)
        val eckAll = EckIdentity.union(keys.eck, listOf(next))
        val newInbox = Secp.generateSecret()
        val rot = rotateFor(ctx, eidSk, prev, next, eckAll, roster.attendees, at, roster.nostrGroupId,
            EckIdentity.union(keys.eck, keys.pendingEck ?: emptyList()))
        stageEck(keys.copy(
            priorEinboxNsecs = ((keys.priorEinboxNsecs ?: emptyList()) + listOfNotNull(keys.einboxNsecHex)).distinct(),
            einboxNsecHex = Bytes.toHex(newInbox),
        ), next)
        publishRotation(ctx, rot)
        promotePending(ctx.coordinate, next)
        reissueOrganizerGrants(ctx, ctx.coordinate)
        val updated = keysFor(ctx.coordinate)!!
        runCatching { writeBackup(ctx.coordinate, updated, updated.coordinatorGen ?: 0) }
        return updated
    }

    /** This device's custody in the backup's shape. */
    private fun asBackup(coordinate: String, keys: EventKeys, gen: Int): EventKeysBackup? {
        val eid = keys.eidNsecHex ?: return null
        val inbox = keys.einboxNsecHex ?: return null
        return EventKeysBackup(a = coordinate, eidNsec = eid, einboxNsec = inbox, eck = keys.eck,
            coordinatorGen = maxOf(gen, keys.coordinatorGen ?: 0), pendingEck = keys.pendingEck, priorEinboxNsecs = keys.priorEinboxNsecs, coOrganizers = keys.coOrganizers)
    }

    class BackupUnreadable : Exception("Couldn't read this event's key backup, so it was not rewritten (that would drop keys saved by your other devices).")

    /**
     * The self-encrypted 30078 backup, rewritten on every rotation/attach as a
     * READ-MERGE-WRITE (SB-89): every device of the account writes this one address,
     * so the current backup is read, merged with this device's ([KeysBackup.merge]),
     * folded into the local record, and the union published. One that exists but
     * cannot be read is not overwritten. [configInbox] picks the current E_inbox.
     */
    private suspend fun writeBackup(coordinate: String, keys: EventKeys, gen: Int, configInbox: String? = null) = lock("eventkeys:$coordinate").withLock {
        val local = asBackup(coordinate, keys, gen) ?: return@withLock
        val signer = accounts.signer
        val me = signer.pubkey
        val d = "nostrautica:eventkeys:" + ProtocolCrypto.blindedD(accounts.blindingKey(), coordinate, me)
        runCatching { nostr.fetch(Relays.DEFAULT, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(me), tags = mapOf("d" to listOf(d)))) }
        val remoteEv = nostr.store.latest(Kinds.APP_DATA, me, d)
        val backup = if (remoteEv != null) {
            val remote = runCatching { Wire.parse(EventKeysBackup.serializer(), signer.nip44Decrypt(me, remoteEv.content)) }.getOrNull() ?: throw BackupUnreadable()
            KeysBackup.merge(local, remote, configInbox).also { m -> foldBackup(coordinate, keys, m) }
        } else local
        accounts.signAndPublish(Kinds.APP_DATA, signer.nip44Encrypt(me, Wire.encode(EventKeysBackup.serializer(), backup)), listOf(listOf("d", d)), Relays.DEFAULT, "eventkeys")
        Unit
    }

    // ── Admin commands, co-organizers ───────────────────────────────────────

    /** 21604 to the coordinator, sealed by E_id, void after 48 h (NIP §3.4). */
    suspend fun sendAdminCommand(ctx: EventContext, cmd: String, args: Map<String, String> = emptyMap()) {
        val coordinator = ctx.cfg.coordinator ?: throw IllegalStateException("no coordinator attached")
        val keys = orgKeys(ctx)
        sendCommandTo(ctx, eidSk(keys), coordinator, cmd, args)
    }

    private suspend fun sendCommandTo(ctx: EventContext, eidSk: ByteArray, coordinator: String, cmd: String, args: Map<String, String>): Boolean {
        val content = AdminCommandContent(
            a = ctx.coordinate, cmd = cmd, args = JsonObject(args.mapValues { JsonPrimitive(it.value) }),
            expires = nowSec() + Limits.ADMIN_COMMAND_TTL_SEC,
        )
        return sendWrap(wrapFromEid(eidSk, coordinator, Kinds.ADMIN_COMMAND, Wire.encode(AdminCommandContent.serializer(), content)), coordinator, ctx, "admin")
    }

    /** 21605: full organizer custody to another account. Returns whether it reached a relay. */
    suspend fun addCoOrganizer(ctx: EventContext, pubkey: String): Boolean {
        var keys = orgKeys(ctx, needInbox = true)
        // Remember who holds custody (SB-90): every rotation re-issues the grant to them.
        if (pubkey != owner) {
            keys = keys.copy(coOrganizers = ((keys.coOrganizers ?: emptyList()) + pubkey).distinct())
            saveKeys(keys)
        }
        return sendOrganizerGrant(ctx, keys, pubkey)
    }

    /** organizer.ts sendOrganizerGrant: full custody, the organizer set, and the retired inboxes. */
    private suspend fun sendOrganizerGrant(ctx: EventContext, keys: EventKeys, to: String): Boolean {
        val eidSk = eidSk(keys)
        val organizers = (listOf(owner) + (keys.coOrganizers ?: emptyList())).distinct().take(Limits.MAX_ORGANIZERS)
        val g = OrganizerGrantContent(
            a = ctx.coordinate, eidNsec = keys.eidNsecHex!!, einboxNsec = keys.einboxNsecHex!!, eck = keys.eck,
            configRelays = ctx.cfg.relays, grantedBy = Secp.pubkeyHex(eidSk),
            organizers = organizers, priorEinboxNsecs = keys.priorEinboxNsecs?.takeLast(Limits.MAX_PRIOR_INBOXES),
        )
        return sendWrap(wrapFromEid(eidSk, to, Kinds.ORGANIZER_GRANT, Wire.encode(OrganizerGrantContent.serializer(), g)), to, ctx, "cohost")
    }

    // ── Custody across devices (organizer.ts checkOrganizerKeys / repairEventKeys / SB-91 guard) ──

    class CoordinatorAttached : Exception(
        "A coordinator is attached to this event, so approvals and removals go through it. Refresh this page and try again.",
    )

    private val freshConfigs = java.util.concurrent.ConcurrentHashMap<String, Pair<EventConfig, Long>>()
    private fun noteFreshConfig(coordinate: String, cfg: EventConfig) { freshConfigs[coordinate] = cfg to System.currentTimeMillis() }

    /**
     * SB-91: never author a 31604 while the newest config names a coordinator. A
     * config noted in the last 90 s (Admin's [checkKeys]) wins over the screen's;
     * otherwise one is read, and a failed read falls back to the screen's.
     */
    private suspend fun assertNoCoordinatorAuthority(ctx: EventContext) {
        var memo = freshConfigs[ctx.coordinate]?.takeIf { System.currentTimeMillis() - it.second <= 90_000 }
        if (memo == null && ctx.cfg.coordinator == null) {
            runCatching { contexts.fetchConfig(ctx.coordinate, ctx.relays) }.getOrNull()?.let { noteFreshConfig(ctx.coordinate, it) }
            memo = freshConfigs[ctx.coordinate]
        }
        val coordinator = if (memo != null) memo.first.coordinator else ctx.cfg.coordinator
        if (coordinator != null) throw CoordinatorAttached()
    }

    data class KeyStatus(val config: EventConfig, val changedElsewhere: Boolean, val collision: Boolean)

    /**
     * Admin's custody check: the newest 31600 (noted for the SB-91 guard), the inbox
     * it names made current when held as a retired one, and whether this device is
     * behind (SB-90) or holds a same-id collision (SB-86). With [reconcile] (once per
     * open) the account's backup is folded in and the union republished if this
     * device holds more (SB-89).
     */
    suspend fun checkKeys(ctx: EventContext, reconcile: Boolean = false): KeyStatus? {
        val cfg = runCatching { contexts.fetchConfig(ctx.coordinate, ctx.relays) }.getOrNull() ?: return null
        noteFreshConfig(ctx.coordinate, cfg)
        if (reconcile) runCatching { reconcileBackup(ctx.coordinate, cfg.inbox) }
        var keys = keysFor(ctx.coordinate) ?: return KeyStatus(cfg, false, false)
        if (keys.role != "organizer") return KeyStatus(cfg, false, false)
        fun pub(s: String) = runCatching { Secp.pubkeyHex(Bytes.fromHex(s)) }.getOrNull()
        val cur = keys.einboxNsecHex
        if (cur != null && pub(cur) != cfg.inbox) {
            val match = keys.priorEinboxNsecs?.firstOrNull { pub(it) == cfg.inbox }
            if (match != null) {
                keys = keys.copy(einboxNsecHex = match, priorEinboxNsecs = (keys.priorEinboxNsecs!!.filter { it != match } + cur).distinct())
                saveKeys(keys)
            }
        }
        val heldInboxes = (listOfNotNull(keys.einboxNsecHex) + (keys.priorEinboxNsecs ?: emptyList())).mapNotNull(::pub)
        val heldEck = (keys.eck + (keys.pendingEck ?: emptyList())).maxOfOrNull { it.id } ?: 0
        val stale = (heldInboxes.isNotEmpty() && cfg.inbox !in heldInboxes) || cfg.eck > heldEck
        val current = keys.current
        return KeyStatus(cfg, stale, current != null && current.id in EckIdentity.collisionIds(keys.eck))
    }

    /** Fold the account's backup in; republish the union only when this device adds something. */
    private suspend fun reconcileBackup(coordinate: String, configInbox: String?) = lock("eventkeys:$coordinate").withLock {
        val keys = keysFor(coordinate) ?: return@withLock
        val local = asBackup(coordinate, keys, keys.coordinatorGen ?: 0) ?: return@withLock
        val signer = accounts.signer
        val me = signer.pubkey
        val d = "nostrautica:eventkeys:" + ProtocolCrypto.blindedD(accounts.blindingKey(), coordinate, me)
        runCatching { nostr.fetch(Relays.DEFAULT, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(me), tags = mapOf("d" to listOf(d)))) }
        val remoteEv = nostr.store.latest(Kinds.APP_DATA, me, d) ?: return@withLock
        val remote = runCatching { Wire.parse(EventKeysBackup.serializer(), signer.nip44Decrypt(me, remoteEv.content)) }.getOrNull() ?: return@withLock
        val m = KeysBackup.merge(local, remote, configInbox)
        foldBackup(coordinate, keys, m)
        fun norm(b: EventKeysBackup) = listOf(EckIdentity.union(b.eck).map { "${it.id}|${it.key}" }, EckIdentity.union(b.pendingEck ?: emptyList()).map { "${it.id}|${it.key}" },
            listOf(b.einboxNsec), (b.priorEinboxNsecs ?: emptyList()).sorted(), listOf("${b.coordinatorGen ?: 0}"), (b.coOrganizers ?: emptyList()).sorted())
        if (norm(m) != norm(remote)) accounts.signAndPublish(Kinds.APP_DATA, signer.nip44Encrypt(me, Wire.encode(EventKeysBackup.serializer(), m)), listOf(listOf("d", d)), Relays.DEFAULT, "eventkeys")
        Unit
    }

    /** Fold a merged backup into the local record (writeBackup / reconcileBackup). */
    private suspend fun foldBackup(coordinate: String, keys: EventKeys, m: EventKeysBackup) {
        val cur = keysFor(coordinate) ?: keys
        val eck = EckIdentity.union(cur.eck, m.eck)
        val folded = cur.copy(eck = eck, pendingEck = EventKeys.pendingMinus(EckIdentity.union(cur.pendingEck ?: emptyList(), m.pendingEck ?: emptyList()), eck),
            einboxNsecHex = m.einboxNsec, priorEinboxNsecs = ((cur.priorEinboxNsecs ?: emptyList()) + (m.priorEinboxNsecs ?: emptyList()) + listOfNotNull(cur.einboxNsecHex)).distinct().filter { it != m.einboxNsec }.ifEmpty { null },
            coordinatorGen = maxOf(cur.coordinatorGen ?: 0, m.coordinatorGen ?: 0).takeIf { it > 0 },
            coOrganizers = ((cur.coOrganizers ?: emptyList()) + (m.coOrganizers ?: emptyList())).distinct().ifEmpty { null })
        if (folded != cur) saveKeys(folded)
    }

    /**
     * Heal a same-id ECK collision (NIP §4.1): mint max id + 1, re-key roster and
     * directory under it, re-grant the full list (both colliding keys) to everyone
     * on the roster, re-issue to co-organizers. Refuses with a coordinator attached.
     */
    suspend fun repairKeys(ctx: EventContext) = lock("roster:${ctx.coordinate}").withLock {
        val cfg = contexts.fetchConfig(ctx.coordinate, ctx.relays) ?: throw IllegalStateException("Event config (31600) not found")
        noteFreshConfig(ctx.coordinate, cfg)
        if (cfg.coordinator != null) throw CoordinatorAttached()
        val keys0 = orgKeys(ctx)
        val eidSk = eidSk(keys0)
        val read = loadRoster(ctx, keys0)
        val keys = keysFor(ctx.coordinate) ?: keys0
        val prev = (read as? OrganizerEvents.RosterRead.Ok)?.eck ?: keys.current ?: throw IllegalStateException("no ECK available")
        val (roster, at) = OrganizerEvents.rosterForRewrite(read, prev.id)
        val next = newEckVersion(keys)
        val eckAll = EckIdentity.union(keys.eck, listOf(next))
        val rot = rotateFor(ctx, eidSk, prev, next, eckAll, roster.attendees, at, roster.nostrGroupId, EckIdentity.union(keys.eck, keys.pendingEck ?: emptyList()))
        val staged = stageEck(keys, next)
        runCatching { writeBackup(ctx.coordinate, staged, staged.coordinatorGen ?: 0, cfg.inbox) }
        publishRotation(ctx, rot)
        promotePending(ctx.coordinate, next)
        reissueOrganizerGrants(ctx, ctx.coordinate)
    }

    /** sendAdminCommand to an explicit coordinator: the one the NEWEST config names (SB-91). */
    suspend fun sendAdminCommandTo(ctx: EventContext, coordinator: String, cmd: String, args: Map<String, String> = emptyMap()): Boolean =
        sendCommandTo(ctx, eidSk(orgKeys(ctx)), coordinator, cmd, args)

    /** After a rotation, every known co-organizer gets the new keys (SB-90); best effort per recipient. */
    private suspend fun reissueOrganizerGrants(ctx: EventContext, coordinate: String) {
        val keys = keysFor(coordinate) ?: return
        if (keys.eidNsecHex == null || keys.einboxNsecHex == null) return
        for (to in keys.coOrganizers ?: emptyList()) if (to != owner) runCatching { sendOrganizerGrant(ctx, keys, to) }
    }

    /** One pass of the organizer-grant wait: pull new grants, re-read custody. */
    suspend fun checkForOrganizerGrant(coordinate: String): EventKeys? {
        accounts.account?.let { grants.receive(it.signer, maxUnwraps = 20) }
        return keysFor(coordinate)?.takeIf { it.role == "organizer" }
    }

    // ── Config (31600) ──────────────────────────────────────────────────────

    data class ConfigChange(
        val talks: String? = null,
        val chat: List<String>? = null,
        val retention: Int? = null,
        val setRetention: Boolean = false,
        val relays: List<String>? = null,
        val maxTalkSec: Int? = null,
    )

    /** organizer.ts updateEventConfig: every other field is preserved; chat relays stay a separate set. */
    suspend fun updateConfig(ctx: EventContext, change: ConfigChange): Boolean {
        val keys = orgKeys(ctx)
        val cfg = ctx.cfg
        val relays = change.relays?.let { OrganizerEvents.unionRelays(it) } ?: cfg.relays
        if (change.relays != null && relays.isEmpty()) throw IllegalArgumentException("at least one relay is required")
        val chat = change.chat ?: cfg.chat
        val chatRelays = if (chat.isNotEmpty()) OrganizerEvents.unionRelays(cfg.chatRelays, OrganizerEvents.chatInteropRelays(relays)) else cfg.chatRelays
        val next = cfg.copy(
            talks = change.talks ?: cfg.talks, chat = chat, relays = relays, chatRelays = chatRelays,
            retentionDays = if (change.setRetention) change.retention else cfg.retentionDays,
            maxTalkSec = change.maxTalkSec ?: cfg.maxTalkSec,
        )
        return publishConfig(ctx, eidSk(keys), next, OrganizerEvents.unionRelays(cfg.relays, relays))
    }

    private suspend fun publishConfig(ctx: EventContext, eidSk: ByteArray, base: EventConfig, relays: List<String>): Boolean {
        // The space hierarchy (§15) is edited from other screens and devices: a settings change built
        // on a cached context must not roll back a link made since. Carry the newest parent/children.
        val fresh = runCatching { contexts.fetchConfig(ctx.coordinate, ctx.cfg.relays) }.getOrNull()
        val cfg = if (fresh != null) base.copy(parent = fresh.parent, children = fresh.children) else base
        val tags = OrganizerEvents.configTags(cfg)
        val all = (relays + Relays.DEFAULT).distinct()
        val (_, ok) = publishMonotonic(eidSk, Kinds.EVENT_CONFIG, cfg.d, all, "config") { at -> UnsignedEvent(cfg.eidPubkey, at, Kinds.EVENT_CONFIG, tags, "") }
        contexts.invalidate(ctx.naddr)
        return ok
    }

    /**
     * Attach a coordinator (NIP §3.5): bump the install generation, rotate ECK +
     * inbox when REPLACING a different coordinator (after a 21604 detach to it),
     * republish the 31600 and gift-wrap the 21603 grant, then persist the gen in
     * custody and the 30078 backup.
     */
    suspend fun attachCoordinator(ctx: EventContext, coordinator: String) {
        var keys = orgKeys(ctx, needInbox = true)
        val eidSk = eidSk(keys)
        val gen = (keys.coordinatorGen ?: 0) + 1
        val cfg = ctx.cfg
        val previous = cfg.coordinator
        var inboxPub = cfg.inbox
        if (previous != null && previous != coordinator) {
            sendCommandTo(ctx, eidSk, previous, "detach", emptyMap())
            keys = rotateEckAndInbox(ctx, keys)
            inboxPub = Secp.pubkeyHex(Bytes.fromHex(keys.einboxNsecHex!!))
        }
        val currentEck = maxOf(keys.eck.maxOfOrNull { it.id } ?: 0, cfg.eck)
        val next = cfg.copy(inbox = inboxPub, coordinator = coordinator, coordinatorGen = gen, eck = currentEck)
        val grant = CoordinatorGrantContent(a = ctx.coordinate, gen = gen, inboxNsec = keys.einboxNsecHex!!, eck = keys.eck, configRelays = cfg.relays)
        val wrap = wrapFromEid(eidSk, coordinator, Kinds.COORDINATOR_GRANT, Wire.encode(CoordinatorGrantContent.serializer(), grant))
        coroutineScope {
            listOf(async { publishConfig(ctx, eidSk, next, cfg.relays) }, async { sendWrap(wrap, coordinator, ctx, "install") }).awaitAll()
        }
        val withGen = keys.copy(coordinatorGen = gen)
        saveKeys(withGen)
        runCatching { writeBackup(ctx.coordinate, withGen, gen) }
    }

    /** Detach: 21604 detach first, rotate, then a 31600 without the coordinator tag. */
    suspend fun detachCoordinator(ctx: EventContext) {
        val cfg = ctx.cfg
        val previous = cfg.coordinator ?: return
        val keys = orgKeys(ctx)
        val eidSk = eidSk(keys)
        sendCommandTo(ctx, eidSk, previous, "detach", emptyMap())
        val rotated = rotateEckAndInbox(ctx, keys)
        val currentEck = maxOf(rotated.eck.maxOfOrNull { it.id } ?: 0, cfg.eck)
        val next = cfg.copy(coordinator = null, coordinatorGen = null, inbox = Secp.pubkeyHex(Bytes.fromHex(rotated.einboxNsecHex!!)), eck = currentEck)
        publishConfig(ctx, eidSk, next, cfg.relays)
    }

    // ── Coordinator discovery, liveness, statuses ───────────────────────────

    suspend fun cachedCoordinators(): List<DiscoveredCoordinator> =
        cache.get(Cache.ANON, "coordinators", ListSerializer(DiscoveredCoordinator.serializer())) ?: emptyList()

    /** kind-31611 announcements, latest per identity, newest first; 1 h TTL. */
    suspend fun fetchCoordinators(force: Boolean = false): List<DiscoveredCoordinator> {
        if (!force && cache.isFresh("coordinators", 3600_000L)) cachedCoordinators().takeIf { it.isNotEmpty() }?.let { return it }
        val r = nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.COORDINATOR_ANNOUNCE)))
        if (r.answered == 0) return cachedCoordinators()
        val latest = HashMap<String, NostrEvent>()
        for (e in r.events) { val p = latest[e.pubkey]; if (p == null || Ordering.supersedes(e, p)) latest[e.pubkey] = e }
        val out = latest.values.mapNotNull { e ->
            (Wire.parseSafe(CoordinatorAnnounce.serializer(), e.content) as? Wire.Result.Ok)?.value?.let { DiscoveredCoordinator(e.pubkey, Nip19.npub(e.pubkey), it, e.createdAt) }
        }.sortedByDescending { it.createdAt }
        cache.put(Cache.ANON, "coordinators", ListSerializer(DiscoveredCoordinator.serializer()), out, nowSec())
        cache.markFetched("coordinators")
        return out
    }

    suspend fun cachedLastSeen(coordinate: String) = cache.get(owner, "coordseen:$coordinate", Long.serializer())

    /** The newest record the coordinator authored for this event: its work product, not a heartbeat. */
    suspend fun fetchCoordinatorLastSeen(ctx: EventContext): Long? {
        val coordinator = ctx.cfg.coordinator ?: return null
        val f = Filter(kinds = listOf(Kinds.DIRECTORY_ENTRY, Kinds.ROSTER, Kinds.MATCH_LIST, Kinds.MATCH_MATRIX), authors = listOf(coordinator), tags = mapOf("a" to listOf(ctx.coordinate)))
        var newest = runCatching { nostr.pool.fetch(ctx.relays, listOf(f, Filter(kinds = listOf(Kinds.ROSTER), authors = listOf(coordinator), tags = mapOf("d" to listOf(ctx.coord.identifier))))) }
            .getOrNull()?.events?.maxOfOrNull { it.createdAt } ?: 0
        newest = maxOf(newest, nostr.store.latest(Kinds.ROSTER, coordinator, ctx.coord.identifier)?.createdAt ?: 0)
        return newest.takeIf { it > 0 }?.also { cache.put(owner, "coordseen:${ctx.coordinate}", Long.serializer(), it, it) }
    }

    suspend fun cachedStatuses(coordinate: String) = cache.get(owner, "coordstatus:$coordinate", ListSerializer(CoordinatorStatusContent.serializer())) ?: emptyList()

    /** 21606 wraps to E_id, authenticated against the configured coordinator. */
    suspend fun fetchCoordinatorStatuses(ctx: EventContext, keys: EventKeys): List<CoordinatorStatusContent> {
        val coordinator = ctx.cfg.coordinator ?: return emptyList()
        val eidSk = eidSk(keys)
        val r = nostr.pool.fetch(ctx.relays, listOf(Filter(kinds = listOf(Kinds.GIFT_WRAP), tags = mapOf("p" to listOf(Secp.pubkeyHex(eidSk))), since = GiftWrap.since())))
        val statuses = r.events.mapNotNull { w ->
            val rumor = runCatching { GiftWrap.unwrapLocal(w, eidSk, setOf(Kinds.COORDINATOR_STATUS)) }.getOrNull() ?: return@mapNotNull null
            if (rumor.pubkey != coordinator) return@mapNotNull null
            (Wire.parseSafe(CoordinatorStatusContent.serializer(), rumor.content) as? Wire.Result.Ok)?.value?.takeIf { it.a == ctx.coordinate }
        }
        val deduped = AdminModel.dedupeLatestStatuses(statuses)
        cache.put(owner, "coordstatus:${ctx.coordinate}", ListSerializer(CoordinatorStatusContent.serializer()), deduped, deduped.maxOfOrNull { it.at } ?: 0)
        return deduped
    }

    // ── Invites (31601) ─────────────────────────────────────────────────────

    class InvitesUnreadable : Exception(
        "Couldn't read this event's published invite list, so no codes were generated. " +
            "Republishing it now would revoke every code already handed out. Check your connection and try again.",
    )

    /** The published `{h, label}` set. Throws rather than answering [] when it can't be established. */
    suspend fun fetchPublishedInvites(ctx: EventContext): List<InviteEntry> {
        val eid = ctx.cfg.eidPubkey
        val id = ctx.coord.identifier
        runCatching { nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.INVITE_LIST), authors = listOf(eid), tags = mapOf("d" to listOf(id))), timeoutMs = 8_000) }
        val latest = nostr.store.latest(Kinds.INVITE_LIST, eid, id)
        if (latest == null) {
            if (seen("invites", ctx.coordinate)) throw InvitesUnreadable()
            return emptyList()
        }
        val list = (Wire.parseSafe(InviteListContent.serializer(), latest.content) as? Wire.Result.Ok)?.value ?: throw InvitesUnreadable()
        markSeen("invites", ctx.coordinate)
        return list.invites
    }

    suspend fun generateInvites(ctx: EventContext, count: Int, labelPrefix: String = "invite", uses: Int? = null, exp: Long? = null): List<GeneratedInvite> =
        lock("invites:${ctx.coordinate}").withLock {
            val keys = orgKeys(ctx)
            val eidSk = eidSk(keys)
            val existing = fetchPublishedInvites(ctx)
            val batch = Invites.mint(existing, count, Route.webUrl(Route.Join(ctx.naddr)), ctx.cfg.lang, labelPrefix, uses, exp)
            val id = ctx.coord.identifier
            val content = Wire.encode(InviteListContent.serializer(), InviteListContent(invites = batch.list))
            publishMonotonic(eidSk, Kinds.INVITE_LIST, id, ctx.relays, "invites") { at ->
                UnsignedEvent(ctx.cfg.eidPubkey, at, Kinds.INVITE_LIST, listOf(listOf("d", id), listOf("a", ctx.coordinate), listOf("v", "2")), content)
            }
            markSeen("invites", ctx.coordinate)
            batch.generated
        }

    suspend fun cachedInviteReport(coordinate: String) = cache.get(owner, "invitereport:$coordinate", Invites.Report.serializer())

    /** Union the fresh 31601 + observed redemptions into the persistent report; never throws. */
    suspend fun refreshInviteReport(ctx: EventContext, pending: List<PendingRequest>): Invites.Report {
        val fresh = runCatching { fetchPublishedInvites(ctx) }.getOrDefault(emptyList()).map { Invites.Issued(it.h, it.label) }
        val stored = cachedInviteReport(ctx.coordinate)
        val issued = Invites.mergeIssued(stored?.issued, fresh)
        val observed = Invites.observeUsed(pending, issued.map { it.h }.toSet(), ctx.coordinate)
        val merged = Invites.Report(issued = Invites.mergeIssued(stored?.issued, issued), used = Invites.mergeUsage(stored?.used, observed))
        cache.put(owner, "invitereport:${ctx.coordinate}", Invites.Report.serializer(), merged, nowSec())
        return merged
    }

    // ── Local review state (stores/review-state.ts), owner-scoped ───────────

    private val reviewSer = MapSerializer(String.serializer(), String.serializer())
    suspend fun loadReview(coordinate: String): Map<String, String> = cache.get(owner, "review:$coordinate", reviewSer) ?: emptyMap()
    suspend fun setReview(coordinate: String, current: Map<String, String>, pubkey: String, state: String?): Map<String, String> {
        val next = current.toMutableMap().apply { if (state == null) remove(pubkey) else put(pubkey, state) }
        cache.put(owner, "review:$coordinate", reviewSer, next, nowSec())
        return next
    }
    suspend fun loadDismissed(coordinate: String): Set<String> = cache.get(owner, "coord-status-dismissed:$coordinate", ListSerializer(String.serializer()))?.toSet() ?: emptySet()
    suspend fun saveDismissed(coordinate: String, ids: Set<String>) = cache.put(owner, "coord-status-dismissed:$coordinate", ListSerializer(String.serializer()), ids.toList(), nowSec())

    // ── Recovery (recover.ts) ───────────────────────────────────────────────

    private val recovered = HashSet<String>()

    /**
     * Restore organizer custody from this account's 30078 eventkeys backups, newest
     * first (EV-10), merging so a fresher local ECK set is never clobbered. A
     * remote signer is asked for at most [maxDecrypts] decrypts per pass.
     */
    suspend fun recoverEventKeys(force: Boolean = false, maxDecrypts: Int = 40): List<String> = lock("recover").withLock {
        val signer = accounts.signer
        val me = signer.pubkey
        if (!force && me in recovered) return@withLock emptyList()
        val held = keyStore.list(me)
        val trustMemo = !force && held.isNotEmpty()
        val memoSer = MapSerializer(String.serializer(), Boolean.serializer())
        val memo = (cache.get(me, "eventkeysbackups", memoSer) ?: emptyMap()).toMutableMap()
        val r = nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(me)))
        val events = nostr.store.query(Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(me))).sortedByDescending { it.createdAt }
        val restored = mutableListOf<String>()
        var candidates = 0; var decrypted = 0; var truncated = false; var budget = maxDecrypts; var dirty = false
        for (e in events) {
            val d = e.d ?: continue
            if (!d.startsWith(EVENTKEYS_PREFIX)) continue
            candidates++
            if (trustMemo && memo[e.id] == true) { decrypted++; continue }
            if (!signer.isLocal && budget-- <= 0) { truncated = true; break }
            val backup = runCatching { Wire.parse(EventKeysBackup.serializer(), signer.nip44Decrypt(me, e.content)) }.getOrNull() ?: continue
            decrypted++
            val coordinate = resolveCoordinate(backup) ?: continue
            restore(me, coordinate, backup)
            memo[e.id] = true; dirty = true
            if (coordinate !in restored) restored += coordinate
        }
        if (dirty) cache.put(me, "eventkeysbackups", memoSer, memo.entries.toList().takeLast(2000).associate { it.key to it.value }, nowSec())
        if (!truncated && r.answered > 0 && (candidates == 0 || decrypted > 0)) recovered += me
        restored
    }

    private suspend fun resolveCoordinate(b: EventKeysBackup): String? {
        b.a?.let { a -> Coordinate.parseOrNull(a)?.let { return a } }
        val eid = runCatching { Secp.pubkeyHex(Bytes.fromHex(b.eidNsec)) }.getOrNull() ?: return null
        runCatching { nostr.fetch(Relays.DEFAULT, Filter(kinds = listOf(Kinds.EVENT_CONFIG), authors = listOf(eid))) }
        val latest = nostr.store.query(Filter(kinds = listOf(Kinds.EVENT_CONFIG), authors = listOf(eid))).maxByOrNull { it.createdAt } ?: return null
        return latest.d?.let { Coordinate(Kinds.CALENDAR_EVENT, eid, it).toString() }
    }

    private suspend fun restore(me: String, coordinate: String, b: EventKeysBackup) {
        val existing = keyStore.get(me, coordinate)
        // The same union a backup write does (keys-backup.ts, SB-89): every inbox kept,
        // the local current one current; ECK by (id, key); staged stays staged.
        val local = existing?.let { k -> asBackup(coordinate, k, k.coordinatorGen ?: 0) }
        val m = if (local != null) KeysBackup.merge(local, b) else KeysBackup.merge(b.copy(eck = EckIdentity.union(existing?.eck ?: emptyList(), b.eck)), b)
        keyStore.save(me, (existing ?: EventKeys(coordinate, "organizer")).copy(
            coordinate = coordinate, role = "organizer", eck = m.eck,
            eidNsecHex = existing?.eidNsecHex ?: m.eidNsec, einboxNsecHex = m.einboxNsec,
            priorEinboxNsecs = m.priorEinboxNsecs,
            coordinatorGen = (m.coordinatorGen ?: 0).takeIf { it > 0 },
            pendingEck = m.pendingEck,
            coOrganizers = m.coOrganizers,
        ))
    }

    // ── Public metadata (event-metadata.ts) ─────────────────────────────────

    data class Metadata(val title: String, val summary: String, val start: Long?, val end: Long?, val location: String?, val icon: String?, val banner: String?)

    /** Republish the 31923/31612 and E_id's kind 0, keeping every tag/field this form doesn't manage. */
    suspend fun updateMetadata(ctx: EventContext, m: Metadata): Boolean {
        val keys = orgKeys(ctx)
        val eidSk = eidSk(keys)
        val c = ctx.coord
        runCatching {
            nostr.fetch(ctx.relays, Filter(kinds = listOf(c.kind), authors = listOf(c.pubkey), tags = mapOf("d" to listOf(c.identifier))), Filter(kinds = listOf(Kinds.PROFILE), authors = listOf(c.pubkey)))
        }
        val priorSpace = nostr.store.latest(c.kind, c.pubkey, c.identifier)
        val priorProfile = nostr.store.latest(Kinds.PROFILE, c.pubkey)
        val managed = setOf("title", "summary", "start", "end", "location", "image", "D")
        val tags = (priorSpace?.tags ?: listOf(listOf("d", c.identifier))).filter { it.isNotEmpty() && it[0] !in managed }.toMutableList()
        if (tags.none { it[0] == "d" }) tags.add(0, listOf("d", c.identifier))
        tags += listOf("title", m.title)
        // A community (31612) has no time or place; the PWA's form requires a start
        // even there, which made a community's details uneditable.
        if (!ctx.isCommunity && m.start != null) {
            tags += listOf("start", m.start.toString())
            m.end?.let { tags += listOf("end", it.toString()) }
            tags += OrganizerEvents.dayIndexTags(m.start, m.end)
        }
        if (m.summary.isNotEmpty()) tags += listOf("summary", m.summary)
        m.banner?.let { tags += listOf("image", it) }
        if (!ctx.isCommunity) m.location?.let { tags += listOf("location", it) }
        val prof = (priorProfile?.content?.let { jsonObjectOf(it) } ?: JsonObject(emptyMap())).toMutableMap()
        prof["name"] = JsonPrimitive(m.title)
        prof["about"] = JsonPrimitive(m.summary)
        if (m.icon != null) prof["picture"] = JsonPrimitive(m.icon) else prof.remove("picture")
        if (m.banner != null) prof["banner"] = JsonPrimitive(m.banner) else prof.remove("banner")
        val profJson = OrganizerEvents.json(JsonObject(prof))
        val (a, b) = coroutineScope {
            val s = async { publishMonotonic(eidSk, c.kind, c.identifier, ctx.relays, "event") { at -> UnsignedEvent(c.pubkey, at, c.kind, tags, m.summary) }.second }
            val p = async { publishMonotonic(eidSk, Kinds.PROFILE, null, ctx.relays, "event") { at -> UnsignedEvent(c.pubkey, at, Kinds.PROFILE, priorProfile?.tags ?: emptyList(), profJson) }.second }
            s.await() to p.await()
        }
        contexts.invalidate(ctx.naddr)
        return a && b
    }

    // ── Event page (31608) and theme (31609) ────────────────────────────────

    data class PageModel(
        val menu: List<today.cypherpunk.nostrautica.protocol.EventPage.Merged<today.cypherpunk.nostrautica.protocol.MenuItem>> = emptyList(),
        val sections: List<today.cypherpunk.nostrautica.protocol.EventPage.Merged<today.cypherpunk.nostrautica.protocol.PageSection>> = emptyList(),
        val sources: List<today.cypherpunk.nostrautica.protocol.ExternalFeed> = emptyList(),
    )

    suspend fun fetchPage(ctx: EventContext): PageModel? {
        val c = ctx.coord
        runCatching { nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.EVENT_PAGE), authors = listOf(c.pubkey), tags = mapOf("d" to listOf(c.identifier)))) }
        return pageFrom(nostr.store.latest(Kinds.EVENT_PAGE, c.pubkey, c.identifier) ?: return null, keysFor(ctx.coordinate))
    }

    private fun pageFrom(latest: NostrEvent, keys: EventKeys?): PageModel? {
        val content = (Wire.parseSafe(today.cypherpunk.nostrautica.protocol.EventPageContent.serializer(), latest.content) as? Wire.Result.Ok)?.value ?: return null
        val pub = today.cypherpunk.nostrautica.protocol.EventPage.rTagsToMenu(latest.tags)
        var priv = today.cypherpunk.nostrautica.protocol.EventPagePrivate()
        if (content.private != null) {
            val eck = keys?.eckFor(latest.tag("eck")?.toIntOrNull())
            if (eck != null) runCatching { priv = today.cypherpunk.nostrautica.protocol.EventPage.decryptPrivate(eck, content.private!!) }
        }
        return PageModel(
            today.cypherpunk.nostrautica.protocol.EventPage.mergeMenu(pub, priv.menu),
            today.cypherpunk.nostrautica.protocol.EventPage.mergeSections(content.sections, priv.sections),
            content.sources,
        )
    }

    suspend fun publishPage(ctx: EventContext, model: PageModel): Boolean {
        val keys = orgKeys(ctx)
        val ep = today.cypherpunk.nostrautica.protocol.EventPage
        val c = ctx.coord
        val (menuPub, menuPriv) = ep.split(model.menu)
        val (secPub, secPriv) = ep.split(model.sections)
        val tags = mutableListOf(listOf("d", c.identifier), listOf("a", ctx.coordinate), listOf("v", "2"))
        var privateCipher: String? = null
        if (menuPriv.isNotEmpty() || secPriv.isNotEmpty()) {
            val eck = keys.current ?: throw IllegalStateException("event content key not available")
            tags += EckIdentity.tag(eck)
            privateCipher = ep.encryptPrivate(eck.bytes(), today.cypherpunk.nostrautica.protocol.EventPagePrivate(
                menu = menuPriv.map { (m, pos) -> m.copy(pos = pos) },
                sections = secPriv.map { (s, pos) -> s.withPos(pos) },
            ))
        }
        tags += ep.menuToRTags(menuPub)
        val o = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        o["v"] = JsonPrimitive(2)
        o["sections"] = Wire.json.encodeToJsonElement(ListSerializer(today.cypherpunk.nostrautica.protocol.PageSection.serializer()), secPub.map { it.withPos(null) })
        if (model.sources.isNotEmpty()) o["sources"] = Wire.json.encodeToJsonElement(ListSerializer(today.cypherpunk.nostrautica.protocol.ExternalFeed.serializer()), model.sources)
        privateCipher?.let { o["private"] = JsonPrimitive(it) }
        val content = OrganizerEvents.json(JsonObject(o))
        return publishMonotonic(eidSk(keys), Kinds.EVENT_PAGE, c.identifier, ctx.relays, "page") { at -> UnsignedEvent(c.pubkey, at, Kinds.EVENT_PAGE, tags, content) }.second
    }

    suspend fun fetchTheme(ctx: EventContext): String {
        val c = ctx.coord
        runCatching { nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.EVENT_THEME), authors = listOf(c.pubkey), tags = mapOf("d" to listOf(c.identifier)))) }
        val e = nostr.store.latest(Kinds.EVENT_THEME, c.pubkey, c.identifier)?.takeIf { Wire.hasCurrentVersionTag(it.tags) } ?: return ""
        return e.content.takeIf { it.isNotBlank() && Bytes.utf8Length(it) <= today.cypherpunk.nostrautica.protocol.EventPage.MAX_THEME_CSS_BYTES } ?: ""
    }

    suspend fun publishTheme(ctx: EventContext, css: String): Boolean {
        val bytes = Bytes.utf8Length(css)
        val max = today.cypherpunk.nostrautica.protocol.EventPage.MAX_THEME_CSS_BYTES
        require(bytes <= max) { "theme CSS is $bytes bytes, over the $max-byte limit" }
        val keys = orgKeys(ctx)
        val c = ctx.coord
        return publishMonotonic(eidSk(keys), Kinds.EVENT_THEME, c.identifier, ctx.relays, "theme") { at ->
            UnsignedEvent(c.pubkey, at, Kinds.EVENT_THEME, listOf(listOf("d", c.identifier), listOf("a", ctx.coordinate), listOf("v", "2")), css)
        }.second
    }

    // ── Posts (posts.ts / updates.ts publishing) ────────────────────────────

    @Serializable
    data class Post(
        val d: String, val kind: Int, val membersOnly: Boolean, val locked: Boolean, val title: String,
        val summary: String? = null, val image: String? = null, val content: String = "",
        val publishedAt: Long, val editedAt: Long, val author: String? = null,
    )

    suspend fun cachedPosts(coordinate: String) = cache.get(owner, "orgposts:$coordinate", ListSerializer(Post.serializer())) ?: emptyList()

    /** This event's own posts (30023 + 31607 by E_id), latest per `d`, newest first. */
    suspend fun fetchPosts(ctx: EventContext): List<Post> {
        val eid = ctx.coord.pubkey
        val f = Filter(kinds = listOf(Kinds.LONGFORM, Kinds.MEMBERS_POST), authors = listOf(eid))
        runCatching { nostr.fetch(ctx.relays, f) }
        val keys = keysFor(ctx.coordinate)
        val now = nowSec()
        val posts = nostr.store.query(f).groupBy { "${it.kind}:${it.d}" }.mapNotNull { Ordering.pickLatest(it.value) }.map { e ->
            val d = e.d ?: ""
            if (e.kind != Kinds.MEMBERS_POST) {
                Post(d, e.kind, false, false, e.tag("title") ?: "Update", e.tag("summary"), e.tag("image"), e.content,
                    minOf(e.tag("published_at")?.toLongOrNull()?.takeIf { it > 0 } ?: e.createdAt, now), e.createdAt)
            } else {
                val eck = keys?.eckFor(e.tag("eck")?.toIntOrNull())
                val p = eck?.let { runCatching { today.cypherpunk.nostrautica.protocol.EventPage.decryptMembersPost(it, e.content) }.getOrNull() }
                if (p == null) Post(d, e.kind, true, true, "", publishedAt = e.createdAt, editedAt = e.createdAt)
                else Post(d, e.kind, true, false, p.title, p.summary, p.image, p.content, minOf(p.publishedAt.takeIf { it > 0 } ?: e.createdAt, now), e.createdAt, p.author)
            }
        }.sortedByDescending { it.publishedAt }
        cache.put(owner, "orgposts:${ctx.coordinate}", ListSerializer(Post.serializer()), posts.take(300), posts.maxOfOrNull { it.editedAt } ?: 0)
        return posts
    }

    data class PostInput(val d: String?, val title: String, val summary: String?, val image: String?, val content: String, val publishedAt: Long?)

    /** A public 30023 update, tied to the event with an `a` tag. */
    suspend fun publishUpdate(ctx: EventContext, p: PostInput): Boolean {
        val keys = orgKeys(ctx)
        val now = nowSec()
        val d = p.d ?: "update-${now.toString(36)}"
        val tags = mutableListOf(listOf("d", d), listOf("title", p.title), listOf("published_at", (p.publishedAt ?: now).toString()), listOf("a", ctx.coordinate))
        p.summary?.let { tags += listOf("summary", it) }
        p.image?.let { tags += listOf("image", it) }
        return publishMonotonic(eidSk(keys), Kinds.LONGFORM, d, ctx.relays, "post") { at -> UnsignedEvent(ctx.cfg.eidPubkey, at, Kinds.LONGFORM, tags, p.content) }.second
    }

    /** A members-only 31607, encrypted under the current ECK. */
    suspend fun publishMembersPost(ctx: EventContext, p: PostInput, author: String?): Boolean {
        val keys = orgKeys(ctx)
        val eck = keys.current ?: throw IllegalStateException("event content key not available")
        val d = p.d ?: Bytes.toHex(Bytes.random(16))
        val cipher = today.cypherpunk.nostrautica.protocol.EventPage.encryptMembersPost(eck.bytes(), today.cypherpunk.nostrautica.protocol.MembersPostContent(
            title = p.title, summary = p.summary, image = p.image, publishedAt = p.publishedAt ?: nowSec(), author = author, content = p.content,
        ))
        return publishMonotonic(eidSk(keys), Kinds.MEMBERS_POST, d, ctx.relays, "post") { at ->
            UnsignedEvent(ctx.cfg.eidPubkey, at, Kinds.MEMBERS_POST, listOf(listOf("d", d), listOf("v", "2"), EckIdentity.tag(eck)), cipher)
        }.second
    }

    // ── Admin display data (cache-first) ────────────────────────────────────

    suspend fun cachedRoster(coordinate: String) = members.cachedRoster(owner, coordinate)
    suspend fun cachedDirectory(coordinate: String) = members.cachedDirectory(owner, coordinate)

    /** Roster + directory for the People list (display only; rewrites use [loadRoster]). */
    suspend fun refreshMembers(ctx: EventContext): Pair<RosterContent?, List<DirectoryEntryContent>?> {
        val roster = runCatching { members.fetchRoster(ctx, owner) }.getOrNull() ?: return null to null
        val dir = runCatching { members.fetchDirectory(ctx, owner, roster) }.getOrNull()
        return roster to dir
    }

    // ── Drafts (stores/drafts.ts) ───────────────────────────────────────────

    private fun draftScope() = accounts.account?.pubkey ?: Cache.ANON
    suspend fun loadDraft(id: String): String? = cache.get(draftScope(), "draft:$id", String.serializer())
    suspend fun saveDraft(id: String, value: String) {
        if (value.isEmpty()) cache.delete(draftScope(), "draft:$id") else cache.put(draftScope(), "draft:$id", String.serializer(), value, nowSec())
    }

    companion object {
        const val EVENTKEYS_PREFIX = "nostrautica:eventkeys:"
        const val GRANT_POLL_MS = 4_000L
    }
}
