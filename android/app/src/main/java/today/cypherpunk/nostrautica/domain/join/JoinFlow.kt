package today.cypherpunk.nostrautica.domain.join

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.EventKeysStore
import today.cypherpunk.nostrautica.domain.media.BlossomClient
import today.cypherpunk.nostrautica.domain.media.IntroMedia
import today.cypherpunk.nostrautica.domain.media.Outcome
import today.cypherpunk.nostrautica.domain.media.SelfCopy
import today.cypherpunk.nostrautica.domain.media.UserFacingError
import today.cypherpunk.nostrautica.domain.media.outcome
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.Ordering
import today.cypherpunk.nostrautica.protocol.ProfileSubmissionContent
import today.cypherpunk.nostrautica.protocol.nowSec
import today.cypherpunk.nostrautica.protocol.AiProfileOverride
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.JoinRequestContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.Nip44
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.ProfileCorrectionContent
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.TalkContent
import today.cypherpunk.nostrautica.protocol.TalkSubmissionContent
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.WithdrawalContent
import today.cypherpunk.nostrautica.protocol.Wire

/** Which of Join's three screens a freshly loaded join page opens on (join.ts). */
enum class JoinLanding { APPROVED, WAITING, FORM }

/** Kind-0 load state for a signed-in joiner (events/profile-load.ts). */
enum class ProfileLoadState { IDLE, LOADING, LOADED, EMPTY, FAILED }

object JoinRules {
    const val POLL_RELAX_AFTER_MS = 3 * 60_000L

    /** Fast checks for an invite (auto-approval), 5 s for a human, 60 s once it's clearly a wait. */
    fun pollGapMs(check: Int, fastChecks: Int, waitedMs: Long): Long = when {
        check < fastChecks -> 1_500
        waitedMs > POLL_RELAX_AFTER_MS -> 60_000
        else -> 5_000
    }

    /** An ECK grant is the truth; an unspent invite code in hand outranks the "already asked" marker. */
    fun landing(approved: Boolean, joinSent: Boolean, hasInvite: Boolean): JoinLanding = when {
        approved -> JoinLanding.APPROVED
        joinSent && !hasInvite -> JoinLanding.WAITING
        else -> JoinLanding.FORM
    }

    data class LoadedProfile(val state: ProfileLoadState, val name: String, val about: String, val picture: String)

    /** A fetch error is NOT an empty profile (UX-O1). */
    fun classifyProfile(name: String?, about: String?, picture: String?, failed: Boolean): LoadedProfile {
        if (failed) return LoadedProfile(ProfileLoadState.FAILED, "", "", "")
        val n = name?.trim().orEmpty()
        val a = about?.trim().orEmpty()
        return LoadedProfile(if (n.isNotEmpty() || a.isNotEmpty()) ProfileLoadState.LOADED else ProfileLoadState.EMPTY, n, a, picture.orEmpty())
    }

    fun canSubmitLoggedIn(state: ProfileLoadState, eventDisplayName: String): Boolean = when (state) {
        ProfileLoadState.LOADED -> true
        ProfileLoadState.EMPTY, ProfileLoadState.FAILED -> eventDisplayName.isNotBlank()
        else -> false
    }

    /** The invite code is an nsec (`#/e/<naddr>/join?code=nsec1…`). */
    fun inviteSecret(code: String): ByteArray =
        runCatching { Nip19.decodeNsec(code.trim()) }.getOrElse { throw UserFacingError("error.inviteCode") }

    /** Build the invite tag `["invite", invitePk, sig]` (NIP §6.5). */
    fun inviteTag(code: String, coordinate: String, attendee: String): List<String> {
        val p = ProtocolCrypto.makeInviteProof(inviteSecret(code), coordinate, attendee)
        return listOf("invite", p.invitePubkey, p.sig)
    }

    /** The 21600 content, bounded so the coordinator can't drop the JOIN as unprocessable. */
    fun joinContent(name: String, message: String, rsvpPublic: Boolean) =
        JoinRequestContent(name = name.take(Limits.MAX_NAME), message = message.take(Limits.MAX_MESSAGE), rsvpPublic = rsvpPublic)
}

data class JoinInput(
    val name: String,
    val message: String = "",
    val rsvpPublic: Boolean = false,
    val profile: AttendeeProfile? = null,
    val media: List<MediaDescriptor> = emptyList(),
    val inviteNsec: String? = null,
)

data class WithdrawResult(val sent: Boolean, val blobsAttempted: Int, val blobsDeleted: Int)

/** Hand-off for editing a talk (talks.ts TalkEditDraft), carried in `Route.Record.editTalk`. */
@Serializable
data class TalkEditDraft(val talkId: String, val title: String, val description: String, val revision: Long)

/**
 * The attendee's writes to an event: join (21600 + 21601 + 31602 + optional 31925),
 * profile correction (21608), talk submission (21609) and leaving (21610). Every
 * rumor is gift-wrapped to E_inbox and goes through the outbox, so it is never
 * lost offline; callers get told whether it actually went out.
 */
class JoinFlow(
    private val nostr: Nostr,
    private val accounts: Accounts,
    private val media: IntroMedia,
    private val keys: EventKeysStore,
) {
    /** Invite codes consumed from links, kept in memory only (invite-store.ts used sessionStorage). */
    private val invites = HashMap<String, String>()

    fun storeInvite(coordinate: String, code: String) = synchronized(invites) { invites[coordinate] = code }
    fun loadInvite(coordinate: String): String? = synchronized(invites) { invites[coordinate] }
    fun clearInvite(coordinate: String) = synchronized(invites) { invites.remove(coordinate) }

    /** join.ts sendJoinRequest. True when every publish went out now; false if anything was queued. */
    suspend fun sendJoinRequest(signer: NostrSigner, ctx: EventContext, input: JoinInput, blindingKey: ByteArray): Boolean {
        val pk = signer.pubkey
        val joinTags = mutableListOf(listOf("a", ctx.coordinate))
        input.inviteNsec?.let { joinTags += JoinRules.inviteTag(it, ctx.coordinate, pk) }
        val join = JoinRules.joinContent(input.name, input.message, input.rsvpPublic)
        val profile = input.profile?.let { AuthoredProfile.normalize(it).profile }
        // rev is REQUIRED on the 21601 (prod incident 2026-07-23), and shares the
        // monotonic per-event counter later edits bump from.
        val prevSelf = runCatching { media.loadSelfCopy(signer, ctx, blindingKey) }.getOrNull()
        val rev = media.nextRev(pk, ctx.coordinate, prevSelf?.rev)

        val joinWrap = accounts.wrap(ctx.cfg.inbox, Kinds.JOIN_REQUEST, Wire.encode(JoinRequestContent.serializer(), join), joinTags)
        val subWrap = profile?.let {
            val s = ProfileSubmissionContent(rev = rev, profile = it, media = input.media.take(Limits.MAX_SUBMISSION_MEDIA))
            media.assertSubmittable(s)
            accounts.wrap(ctx.cfg.inbox, Kinds.PROFILE_SUBMISSION, Wire.json.encodeToString(ProfileSubmissionContent.serializer(), s), listOf(listOf("a", ctx.coordinate)))
        }
        val self = SelfCopy(profile, input.media, null, rev)
        val selfEvent = media.signSelfCopy(signer, ctx, blindingKey, self)
        val rsvp = if (input.rsvpPublic) {
            val tags = listOf(listOf("a", ctx.coordinate), listOf("d", "${ctx.coordinate}:$pk"), listOf("status", "accepted"))
            val d = "${ctx.coordinate}:$pk"
            signer.sign(UnsignedEvent(pk, accounts.monotonicCreatedAt(Kinds.CALENDAR_RSVP, pk, d), Kinds.CALENDAR_RSVP, tags, ""))
        } else null

        val results = coroutineScope {
            listOfNotNull(
                async { nostr.publish(joinWrap, ctx.relays, pk, "join") },
                subWrap?.let { w -> async { nostr.publish(w, ctx.relays, pk, "join profile") } },
                async {
                    nostr.publish(selfEvent, Relays.DEFAULT, pk, "self-copy").also {
                        // Seed the local copy: "record your intro" on the same bad Wi-Fi builds from it.
                        media.cacheSelfCopy(pk, ctx.coordinate, self, selfEvent.createdAt)
                    }
                },
                rsvp?.let { e -> async { nostr.publish(e, ctx.relays, pk, "rsvp") } },
            ).map { it.await() }
        }
        return results.all { it is Nostr.PublishResult.Published }
    }

    /** correction.ts: a 21608 to E_inbox, rev claimed across devices, recorded on the self-copy. */
    suspend fun submitCorrection(
        signer: NostrSigner,
        ctx: EventContext,
        overrides: AiProfileOverride? = null,
        hidden: Boolean? = null,
        hiddenFields: List<String>? = null,
        report: String? = null,
    ): Outcome {
        val bk = accounts.blindingKey()
        val claim = media.claimCorrectionRev(signer, ctx, bk)
        val content = ProfileCorrectionContent(a = ctx.coordinate, rev = claim.rev, overrides = overrides, hidden = hidden, hiddenFields = hiddenFields, report = report)
        val wrap = accounts.wrap(ctx.cfg.inbox, Kinds.PROFILE_CORRECTION, Wire.encode(ProfileCorrectionContent.serializer(), content), listOf(listOf("a", ctx.coordinate)))
        val out = nostr.publish(wrap, ctx.relays, signer.pubkey, "correction").outcome()
        runCatching { claim.record() }
        return out
    }

    /** talks.ts submitTalk: a 21609 to E_inbox; editing resubmits the same talk_d with a bumped revision. */
    suspend fun submitTalk(
        signer: NostrSigner,
        ctx: EventContext,
        talkId: String,
        title: String,
        description: String,
        revision: Long,
        media: MediaDescriptor? = null,
        externalUrl: String? = null,
        externalKind: String? = null,
        sourceType: String? = null,
        processForMatching: Boolean = false,
    ): Outcome {
        val content = TalkSubmissionContent(
            a = ctx.coordinate, talkD = talkId, title = title, description = description, speakers = emptyList(),
            media = media, externalUrl = if (media == null) externalUrl else null, externalKind = if (media == null) externalKind else null,
            sourceType = sourceType, processForMatching = processForMatching, revision = revision,
        )
        val wrap = accounts.wrap(ctx.cfg.inbox, Kinds.TALK_SUBMISSION, Wire.encode(TalkSubmissionContent.serializer(), content), listOf(listOf("a", ctx.coordinate)))
        return nostr.publish(wrap, ctx.relays, signer.pubkey, "talk").outcome()
    }

    /**
     * Resolve `Route.Record.editTalk`: a JSON [TalkEditDraft] (from [encodeTalkEdit]),
     * or the blinded `d` of a 31610 this speaker gave, looked up on the phone and
     * decrypted with the event key.
     */
    suspend fun resolveTalkEdit(owner: String, ctx: EventContext, editTalk: String): TalkEditDraft? {
        if (editTalk.trimStart().startsWith("{")) return runCatching { json.decodeFromString(TalkEditDraft.serializer(), editTalk) }.getOrNull()
        val authors = listOfNotNull(ctx.cfg.coordinator, ctx.cfg.eidPubkey)
        val ev = nostr.store.query(Filter(kinds = listOf(Kinds.TALK), authors = authors, tags = mapOf("d" to listOf(editTalk))))
            .let(Ordering::pickLatest) ?: return null
        val k = keys.get(owner, ctx.coordinate) ?: return null
        val eck = k.eckFor(ev.tag("eck")?.toIntOrNull()) ?: k.current?.bytes() ?: return null
        val talk = runCatching { Wire.parse(TalkContent.serializer(), Nip44.eckDecrypt(eck, ev.content)) }.getOrNull() ?: return null
        if (talk.pubkey != owner) return null
        return TalkEditDraft(talk.talkD, talk.title, talk.description, talk.revision)
    }

    /**
     * withdraw.ts: the 21610 is the load-bearing step (outbox-backed); deleting own
     * Blossom blobs and NIP-09-deleting the self-copy are best-effort and never fail it.
     */
    suspend fun withdraw(signer: NostrSigner, ctx: EventContext, deleteData: Boolean = true): WithdrawResult {
        val pk = signer.pubkey
        val content = WithdrawalContent(a = ctx.coordinate, deleteData = deleteData)
        val wrap = accounts.wrap(ctx.cfg.inbox, Kinds.ATTENDEE_WITHDRAWAL, Wire.encode(WithdrawalContent.serializer(), content), listOf(listOf("a", ctx.coordinate)))
        val sent = nostr.publish(wrap, ctx.relays, pk, "leave") is Nostr.PublishResult.Published
        var attempted = 0
        var deleted = 0
        runCatching {
            val bk = accounts.blindingKey()
            val self = runCatching { media.loadSelfCopy(signer, ctx, bk) }.getOrNull()
            val hashes = self?.media?.map { it.x }?.distinct() ?: emptyList()
            if (hashes.isNotEmpty()) {
                val servers = BlossomClient.union(media.resolveBlossomServers(ctx), runCatching { media.userBlossomServers(pk) }.getOrDefault(emptyList()))
                for (x in hashes) {
                    attempted++
                    val ok = coroutineScope { servers.map { s -> async { media.blossom.delete(signer, s, x) } }.map { it.await() } }
                    if (ok.any { it }) deleted++
                }
            }
            val tags = listOf(listOf("a", media.selfCopyAddress(pk, bk, ctx.coordinate)), listOf("k", Kinds.MY_PROFILE.toString()))
            val deletion = signer.sign(UnsignedEvent(pk, nowSec(), Kinds.DELETION, tags, "withdrew from event"))
            nostr.publish(deletion, ctx.relays, pk, "delete self-copy")
        }
        return WithdrawResult(sent, attempted, deleted)
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun newTalkId(): String = Bytes.toHex(Bytes.random(8))

        /** For the Talks area: `Route.Record(naddr, talk = true, editTalk = JoinFlow.encodeTalkEdit(...))`. */
        fun encodeTalkEdit(d: TalkEditDraft): String = json.encodeToString(TalkEditDraft.serializer(), d)
    }
}
