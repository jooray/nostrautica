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
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.EventConfig
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
        Organizer(nostr, cache, eventKeys, contexts, accounts, members, profiles, grants, OrganizerBlossom(http, nostr, cache))
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

    data class CreateResult(val created: OrganizerEvents.Created, val naddr: String, val published: Boolean)

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
        return CreateResult(c, c.naddr, results.all { it })
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
        approve(ctx, PendingRequest(me, name, profile = profile, rumorCreatedAt = nowSec()), "organizer")
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
        fun dec(e: NostrEvent): RosterContent? {
            val eck = keys.eckFor(e.tag("eck")?.toIntOrNull()) ?: keys.current?.bytes() ?: return null
            return (runCatching { Wire.parseSafe(RosterContent.serializer(), Nip44.eckDecrypt(eck, e.content)) }.getOrNull() as? Wire.Result.Ok)?.value
        }
        val page0 = dec(latest) ?: return OrganizerEvents.RosterRead.Unreadable(at)
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
        return OrganizerEvents.RosterRead.Ok(roster, at)
    }

    // ── Approve (organizer.ts approveAttendee) ──────────────────────────────

    suspend fun approve(ctx: EventContext, req: PendingRequest, role: String = "attendee") = lock("roster:${ctx.coordinate}").withLock {
        val keys = orgKeys(ctx)
        val eck = keys.current ?: throw IllegalStateException("no ECK available")
        val eidSk = eidSk(keys)
        val eid = Secp.pubkeyHex(eidSk)
        val eckBytes = eck.bytes()
        val grant = Wire.encode(KeyGrantContent.serializer(), KeyGrantContent(a = ctx.coordinate, role = role, eck = keys.eck, grantedBy = eid))
        val grantWrap = wrapFromEid(eidSk, req.attendeePubkey, Kinds.KEY_GRANT, grant)
        val entryD = ProtocolCrypto.blindedD(eckBytes, ctx.coordinate, req.attendeePubkey)
        val now = nowSec()
        val entry = DirectoryEntryContent(
            pubkey = req.attendeePubkey, name = req.name.ifEmpty { null }, profile = req.profile ?: AttendeeProfile(),
            media = req.media ?: emptyList(), introText = req.introText, updatedAt = now,
        )
        val entryEvent = UnsignedEvent(
            eid, now, Kinds.DIRECTORY_ENTRY,
            listOf(listOf("d", entryD), listOf("a", ctx.coordinate), listOf("eck", eck.id.toString()), listOf("v", "2")),
            Nip44.eckEncrypt(eckBytes, Wire.encode(DirectoryEntryContent.serializer(), entry)),
        ).signWith(eidSk)
        val (roster, at) = OrganizerEvents.rosterForRewrite(loadRoster(ctx, keys), eck.id)
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

    // ── Revoke and rotation (organizer.ts revokeAttendeeClient / rotateEckAndInbox) ──

    private suspend fun directoryContents(ctx: EventContext, ds: List<String>, eck: ByteArray): Map<String, String> {
        val cfg = ctx.cfg
        val publisher = cfg.coordinator ?: cfg.eidPubkey
        ds.chunked(Members.D_CHUNK).forEach { chunk ->
            runCatching { nostr.fetch(ctx.relays, Filter(kinds = listOf(Kinds.DIRECTORY_ENTRY), authors = listOf(publisher), tags = mapOf("d" to chunk))) }
        }
        return ds.mapNotNull { d ->
            val e = nostr.store.latest(Kinds.DIRECTORY_ENTRY, publisher, d) ?: return@mapNotNull null
            runCatching { Nip44.eckDecrypt(eck, e.content) }.getOrNull()?.let { d to it }
        }.toMap()
    }

    private data class Rotation(val events: List<NostrEvent>, val grants: List<Pair<String, NostrEvent>>)

    /** Re-encrypt [remaining]'s entries under the new ECK, re-grant everyone, rebuild the roster. */
    private suspend fun rotateFor(ctx: EventContext, eidSk: ByteArray, prev: EckVersion, next: EckVersion, eckAll: List<EckVersion>, remaining: List<RosterAttendee>, rosterAt: Long, nostrGroupId: String?): Rotation {
        val eid = Secp.pubkeyHex(eidSk)
        val newBytes = next.bytes()
        val plain = directoryContents(ctx, remaining.map { it.d }, prev.bytes())
        val events = mutableListOf<NostrEvent>()
        val grantWraps = mutableListOf<Pair<String, NostrEvent>>()
        val newRoster = OrganizerEvents.rederive(ctx.coordinate, remaining, newBytes)
        for ((a, re) in remaining.zip(newRoster)) {
            val newD = re.d
            plain[a.d]?.let { json ->
                events += UnsignedEvent(eid, nowSec(), Kinds.DIRECTORY_ENTRY,
                    listOf(listOf("d", newD), listOf("a", ctx.coordinate), listOf("eck", next.id.toString()), listOf("v", "2")),
                    Nip44.eckEncrypt(newBytes, json)).signWith(eidSk)
            }
            val grant = Wire.encode(KeyGrantContent.serializer(), KeyGrantContent(a = ctx.coordinate, role = a.role, eck = eckAll, grantedBy = eid))
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

    private fun newEckVersion(k: EventKeys) = OrganizerEvents.nextEck(k.eck, ProtocolCrypto.generateEck())

    /** Revoke without a coordinator: forward-only ECK rotation, everyone else re-granted. */
    suspend fun revokeClient(ctx: EventContext, removed: String) = lock("roster:${ctx.coordinate}").withLock {
        val keys = orgKeys(ctx)
        val eidSk = eidSk(keys)
        val prev = keys.current ?: throw IllegalStateException("no ECK available")
        // Read BEFORE minting: an aborted revoke must leave custody untouched.
        val (roster, at) = OrganizerEvents.rosterForRewrite(loadRoster(ctx, keys), prev.id)
        if (roster.attendees.none { it.pubkey == removed }) {
            throw IllegalStateException("That attendee isn't on the roster we just read, so nothing was published. Reload the People list and try again.")
        }
        val removedD = ProtocolCrypto.blindedD(prev.bytes(), ctx.coordinate, removed)
        val deletion = UnsignedEvent(Secp.pubkeyHex(eidSk), nowSec(), Kinds.DELETION,
            listOf(listOf("a", "${Kinds.DIRECTORY_ENTRY}:${ctx.cfg.eidPubkey}:$removedD"), listOf("k", Kinds.DIRECTORY_ENTRY.toString())), "revoked").signWith(eidSk)
        val next = newEckVersion(keys)
        val updated = keys.copy(eck = keys.eck + next)
        saveKeys(updated)
        // The rotated ECK must reach the durable backup, or a fresh device restores v1 only.
        runCatching { writeBackup(ctx.coordinate, updated, updated.coordinatorGen ?: 0) }
        val rot = rotateFor(ctx, eidSk, prev, next, updated.eck, roster.attendees.filter { it.pubkey != removed }, at, roster.nostrGroupId)
        publishRotation(ctx, rot, listOf(deletion))
    }

    /** Detach/replace (NIP §3.7): rotate the ECK AND E_inbox; the old inbox is kept for history. */
    private suspend fun rotateEckAndInbox(ctx: EventContext, keys: EventKeys): EventKeys {
        val eidSk = eidSk(keys)
        val prev = keys.current ?: throw IllegalStateException("no ECK available")
        val read = loadRoster(ctx, keys)
        val (roster, at) = OrganizerEvents.rosterForRewrite(read, prev.id)
        val next = newEckVersion(keys)
        val eckAll = keys.eck + next
        val newInbox = Secp.generateSecret()
        val rot = rotateFor(ctx, eidSk, prev, next, eckAll, roster.attendees, at, roster.nostrGroupId)
        publishRotation(ctx, rot)
        val updated = keys.copy(
            eck = eckAll,
            priorEinboxNsecs = ((keys.priorEinboxNsecs ?: emptyList()) + listOfNotNull(keys.einboxNsecHex)).distinct(),
            einboxNsecHex = Bytes.toHex(newInbox),
        )
        saveKeys(updated)
        runCatching { writeBackup(ctx.coordinate, updated, updated.coordinatorGen ?: 0) }
        return updated
    }

    /** The self-encrypted 30078 backup, rewritten on every rotation/attach (monotonic). */
    private suspend fun writeBackup(coordinate: String, keys: EventKeys, gen: Int) {
        if (keys.eidNsecHex == null || keys.einboxNsecHex == null) return
        val signer = accounts.signer
        val me = signer.pubkey
        val backup = EventKeysBackup(a = coordinate, eidNsec = keys.eidNsecHex, einboxNsec = keys.einboxNsecHex, eck = keys.eck, coordinatorGen = gen)
        val d = "nostrautica:eventkeys:" + ProtocolCrypto.blindedD(accounts.blindingKey(), coordinate, me)
        accounts.signAndPublish(Kinds.APP_DATA, signer.nip44Encrypt(me, Wire.encode(EventKeysBackup.serializer(), backup)), listOf(listOf("d", d)), Relays.DEFAULT, "eventkeys")
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
        val keys = orgKeys(ctx, needInbox = true)
        val eidSk = eidSk(keys)
        val g = OrganizerGrantContent(
            a = ctx.coordinate, eidNsec = keys.eidNsecHex!!, einboxNsec = keys.einboxNsecHex!!, eck = keys.eck,
            configRelays = ctx.cfg.relays, grantedBy = Secp.pubkeyHex(eidSk),
        )
        return sendWrap(wrapFromEid(eidSk, pubkey, Kinds.ORGANIZER_GRANT, Wire.encode(OrganizerGrantContent.serializer(), g)), pubkey, ctx, "cohost")
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

    private suspend fun publishConfig(ctx: EventContext, eidSk: ByteArray, cfg: EventConfig, relays: List<String>): Boolean {
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
        val byId = LinkedHashMap<Int, EckVersion>()
        existing?.eck?.forEach { byId[it.id] = it }
        b.eck.forEach { if (it.id !in byId) byId[it.id] = it }
        keyStore.save(me, EventKeys(
            coordinate = coordinate, role = "organizer", eck = byId.values.sortedBy { it.id },
            eidNsecHex = existing?.eidNsecHex ?: b.eidNsec, einboxNsecHex = existing?.einboxNsecHex ?: b.einboxNsec,
            priorEinboxNsecs = existing?.priorEinboxNsecs,
            coordinatorGen = maxOf(existing?.coordinatorGen ?: 0, b.coordinatorGen ?: 0).takeIf { it > 0 },
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
            tags += listOf("eck", eck.id.toString())
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
            UnsignedEvent(ctx.cfg.eidPubkey, at, Kinds.MEMBERS_POST, listOf(listOf("d", d), listOf("v", "2"), listOf("eck", eck.id.toString())), cipher)
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
