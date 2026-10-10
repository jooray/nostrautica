package today.cypherpunk.nostrautica.domain.join

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.Grants
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.media.IntroMedia
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.nowSec

@Serializable enum class StepId { JOINED, BACKUP, INTRO, PROCESSING, MATCHES }
@Serializable enum class StepState { COMPLETE, ACTION_REQUIRED, IN_PROGRESS, WAITING, FAILED, CHECKING }

/** Where the one primary CTA goes; the UI maps it to a route. */
@Serializable enum class CtaTarget { JOIN, BACKUP, RECORD, MY_PROFILE }

@Serializable data class Cta(val labelKey: String, val target: CtaTarget)

@Serializable data class Step(val id: StepId, val state: StepState, val labelKey: String, val hintKey: String? = null)

@Serializable
data class Readiness(
    val steps: List<Step>,
    val doneCount: Int,
    val currentIndex: Int,
    val allComplete: Boolean,
    val primary: Cta?,
    val matchesReady: Boolean,
    val viewerIsMember: Boolean,
) {
    val isMemberSnapshot: Boolean get() = steps.any { it.id == StepId.JOINED && it.state == StepState.COMPLETE }
}

data class ProcessingFailure(val stage: String?, val errorCategory: String?, val retryable: Boolean?)

/** role: "unknown" | "visitor" | "pending" | "attendee" | "organizer" (readiness.ts). */
data class ReadinessInput(
    val role: String,
    /** True for NIP-55 / NIP-46 signers: the key lives in the signer. */
    val signerHoldsKey: Boolean = false,
    val backupAcked: Boolean? = null,
    val hasIntro: Boolean? = null,
    val profileEmpty: Boolean? = null,
    val processed: Boolean? = null,
    val processingFailed: ProcessingFailure? = null,
    val matchesAvailable: Boolean? = null,
    val matchingEnabled: Boolean,
    val hasCoordinator: Boolean,
    val latched: Set<StepId> = emptySet(),
)

/** events/readiness.ts — the pure stepper derivation, one primary CTA at most. */
object ReadinessRules {
    private val LABEL = mapOf(
        StepId.JOINED to "readiness.step.joined",
        StepId.BACKUP to "readiness.step.backup",
        StepId.INTRO to "readiness.step.intro",
        StepId.PROCESSING to "readiness.step.processing",
        StepId.MATCHES to "readiness.step.matches",
    )
    private val MEDIA_ERRORS = setOf("media_fetch", "media_integrity", "media_processing")

    fun isMediaFailure(category: String?) = category != null && category in MEDIA_ERRORS

    /** The matcher refuses an empty profile; anything at all counts (readiness.ts hasAnythingToMatchOn). */
    fun hasAnythingToMatchOn(e: DirectoryEntryContent?): Boolean {
        if (e == null) return false
        val p = e.profile
        if (p.about.isNotBlank() || p.skills.isNotEmpty() || p.lookingFor.isNotBlank()) return true
        if (!e.introText.isNullOrBlank()) return true
        if (e.media.isNotEmpty()) return true
        return e.aiProfile?.hasContent == true
    }

    private fun step(id: StepId, state: StepState, hint: String? = null) = Step(id, state, LABEL.getValue(id), hint)

    private fun primaryFor(id: StepId, profileEmpty: Boolean?, failure: ProcessingFailure?): Cta? = when (id) {
        StepId.PROCESSING -> if (isMediaFailure(failure?.errorCategory)) Cta("readiness.cta.rerecord", CtaTarget.RECORD) else Cta("readiness.cta.editProfile", CtaTarget.MY_PROFILE)
        StepId.JOINED -> Cta("readiness.cta.join", CtaTarget.JOIN)
        StepId.BACKUP -> Cta("readiness.cta.backup", CtaTarget.BACKUP)
        StepId.INTRO -> if (profileEmpty == true) Cta("readiness.cta.profile", CtaTarget.MY_PROFILE) else Cta("readiness.cta.record", CtaTarget.RECORD)
        else -> null
    }

    fun derive(i: ReadinessInput): Readiness {
        val isMember = i.role == "attendee" || i.role == "organizer"
        val five = i.hasCoordinator && i.matchingEnabled
        val steps = mutableListOf<Step>()

        steps += when {
            isMember -> step(StepId.JOINED, StepState.COMPLETE)
            i.role == "unknown" -> step(StepId.JOINED, StepState.CHECKING, "readiness.hint.checking")
            i.role == "pending" -> step(StepId.JOINED, StepState.IN_PROGRESS, "readiness.hint.pending")
            else -> step(StepId.JOINED, StepState.ACTION_REQUIRED)
        }
        steps += when {
            i.signerHoldsKey -> step(StepId.BACKUP, StepState.COMPLETE, "readiness.hint.signerKey")
            i.backupAcked == true -> step(StepId.BACKUP, StepState.COMPLETE)
            i.backupAcked == false -> step(StepId.BACKUP, StepState.ACTION_REQUIRED, "readiness.hint.backup")
            else -> step(StepId.BACKUP, StepState.CHECKING, "readiness.hint.checking")
        }
        steps += when (i.hasIntro) {
            true -> step(StepId.INTRO, StepState.COMPLETE)
            false -> step(StepId.INTRO, StepState.ACTION_REQUIRED, if (i.profileEmpty == true) "readiness.hint.empty" else "readiness.hint.intro")
            null -> step(StepId.INTRO, StepState.CHECKING, "readiness.hint.checking")
        }
        if (five) {
            steps += when {
                i.processed == true -> step(StepId.PROCESSING, StepState.COMPLETE)
                i.processingFailed != null -> step(StepId.PROCESSING, StepState.FAILED,
                    if (isMediaFailure(i.processingFailed.errorCategory)) "readiness.hint.failedMedia" else "readiness.hint.failed")
                i.processed == false -> step(StepId.PROCESSING, StepState.IN_PROGRESS, "readiness.hint.processing")
                else -> step(StepId.PROCESSING, StepState.CHECKING, "readiness.hint.checking")
            }
            steps += when (i.matchesAvailable) {
                true -> step(StepId.MATCHES, StepState.COMPLETE)
                null -> step(StepId.MATCHES, StepState.CHECKING, "readiness.hint.checking")
                false -> step(StepId.MATCHES, StepState.WAITING)
            }
        }

        // Monotonic latch: outranks an ABSENCE of evidence, not a read entry with
        // nothing built plus a failure notice (audit A-2).
        val nothingBuilt = i.processed == false && i.processingFailed != null
        val latched = steps.map { s ->
            if (s.id in i.latched && !(s.state == StepState.FAILED && nothingBuilt)) s.copy(state = StepState.COMPLETE, hintKey = null) else s
        }

        val done = latched.count { it.state == StepState.COMPLETE }
        val current = latched.indexOfFirst { it.state != StepState.COMPLETE }
        val action = if (isMember) latched.firstOrNull { it.state == StepState.FAILED } ?: latched.firstOrNull { it.state == StepState.ACTION_REQUIRED }
        else latched.firstOrNull { it.id == StepId.JOINED && it.state == StepState.ACTION_REQUIRED }
        return Readiness(
            steps = latched,
            doneCount = done,
            currentIndex = current,
            allComplete = current == -1,
            primary = action?.let { primaryFor(it.id, i.profileEmpty, i.processingFailed) },
            matchesReady = latched.any { it.id == StepId.MATCHES && it.state == StepState.COMPLETE },
            viewerIsMember = isMember,
        )
    }
}

/**
 * The readiness store (readiness.svelte.ts), two phases: [local] paints from what
 * is on the phone (custody, cached self-copy, own-status notices) with no network
 * and no signer prompt; [refine] asks relays (directory entry, matches, the
 * self-copy only when the cache can't already prove an intro).
 *
 * The latch (steps ever completed) and the last MEMBER snapshot persist per owner
 * and event, so a finished step never regresses offline, and a "you still need to
 * join" verdict is never cached (it's what a half-restored identity produces).
 */
class ReadinessTracker(
    private val nostr: Nostr,
    private val cache: Cache,
    private val members: Members,
    private val grants: Grants,
    private val media: IntroMedia,
) {
    @Serializable
    data class Persisted(val v: Int, val readiness: Readiness, val latched: List<StepId>, val checkedAt: Long? = null)

    private fun key(c: String) = "readiness:$c"

    suspend fun cached(owner: String, coordinate: String): Persisted? =
        cache.get(owner, key(coordinate), Persisted.serializer())?.takeIf { it.v == VERSION }

    fun roleName(r: Role) = when (r) {
        Role.ORGANIZER -> "organizer"
        Role.ATTENDEE -> "attendee"
        Role.PENDING -> "pending"
        Role.VISITOR -> "visitor"
    }

    /** The coordinator's "your profile pipeline stopped" notice (21606 → me), if any. */
    suspend fun processingFailure(owner: String, coordinate: String): ProcessingFailure? =
        grants.ownStatuses(owner, coordinate)
            .filter { it.state == "poison" && it.billing == null && it.stage == PROCESSING_STAGE }
            .maxByOrNull { it.at }
            ?.let { ProcessingFailure(it.stage, it.errorCategory, it.retryable) }

    /** Durable key-backup marker (key-backup.ts): a 30078 `nostrautica:keybackup` exists. Positive answers are cached. */
    suspend fun hasDurableKeyBackup(pubkey: String, network: Boolean): Boolean? {
        if (cache.get(pubkey, "keybackup", Boolean.serializer()) == true) return true
        if (!network) return null
        val r = runCatching { nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.APP_DATA), authors = listOf(pubkey), tags = mapOf("d" to listOf(KEY_BACKUP_D)))) }.getOrNull()
        val has = nostr.store.latest(Kinds.APP_DATA, pubkey, KEY_BACKUP_D) != null
        if (has) cache.put(pubkey, "keybackup", Boolean.serializer(), true, nowSec())
        return if (has) true else if ((r?.answered ?: 0) > 0) false else null
    }

    data class Parts(
        val role: String,
        val signerHoldsKey: Boolean,
        val backupAcked: Boolean?,
        val hasIntro: Boolean?,
        val profileEmpty: Boolean? = null,
        val processed: Boolean? = null,
        val matchesAvailable: Boolean? = null,
    )

    private suspend fun derive(owner: String, ctx: EventContext, p: Parts, latch: MutableSet<StepId>): Readiness {
        val r = ReadinessRules.derive(
            ReadinessInput(
                role = p.role, signerHoldsKey = p.signerHoldsKey, backupAcked = p.backupAcked, hasIntro = p.hasIntro,
                profileEmpty = p.profileEmpty, processed = p.processed, processingFailed = processingFailure(owner, ctx.coordinate),
                matchesAvailable = p.matchesAvailable, matchingEnabled = ctx.cfg.matching, hasCoordinator = ctx.cfg.coordinator != null,
                latched = latch,
            ),
        )
        latch += r.steps.filter { it.state == StepState.COMPLETE }.map { it.id }
        return r
    }

    private suspend fun commit(owner: String, coordinate: String, r: Readiness, latch: Set<StepId>, checkedAt: Long?) {
        if (!r.isMemberSnapshot) return
        cache.put(owner, key(coordinate), Persisted.serializer(), Persisted(VERSION, r, latch.toList(), checkedAt), nowSec())
    }

    /**
     * Phone only. [localBackupOk]: this device's own "I saved my key" state (a fresh
     * generated key not yet backed up = false).
     */
    suspend fun local(owner: String, ctx: EventContext, role: Role, signerHoldsKey: Boolean, localBackupOk: Boolean): Pair<Readiness, Parts> {
        val prev = cached(owner, ctx.coordinate)
        val latch = (prev?.latched ?: emptyList()).toMutableSet()
        val self = media.cachedSelfCopy(owner, ctx.coordinate)
        val durable = if (signerHoldsKey) null else hasDurableKeyBackup(owner, network = false)
        val parts = Parts(
            role = roleName(role),
            signerHoldsKey = signerHoldsKey,
            backupAcked = if (signerHoldsKey) null else if (durable == true || localBackupOk) true else null,
            hasIntro = self?.hasIntro?.takeIf { it },
        )
        val r = derive(owner, ctx, parts, latch)
        // A persisted member snapshot carries refined steps; keep it while custody agrees.
        val keepCached = prev != null && prev.readiness.isMemberSnapshot && (role == Role.ATTENDEE || role == Role.ORGANIZER)
        if (keepCached && prev != null) return prev.readiness to parts
        commit(owner, ctx.coordinate, r, latch, prev?.checkedAt)
        return r to parts
    }

    /** Network phase. Returns the refined card and when it was checked. */
    suspend fun refine(signer: NostrSigner, ctx: EventContext, role: Role, signerHoldsKey: Boolean, localBackupOk: Boolean, blindingKey: suspend () -> ByteArray): Pair<Readiness, Long> {
        val owner = signer.pubkey
        val latch = (cached(owner, ctx.coordinate)?.latched ?: emptyList()).toMutableSet()
        val isMember = role == Role.ATTENDEE || role == Role.ORGANIZER
        var backup: Boolean? = null
        if (!signerHoldsKey) {
            val durable = hasDurableKeyBackup(owner, network = true)
            backup = if (durable == true || localBackupOk) true else durable
        }
        var hasIntro: Boolean? = media.cachedSelfCopy(owner, ctx.coordinate)?.hasIntro?.takeIf { it }
        var processed: Boolean? = null
        var profileEmpty: Boolean? = null
        var matches: Boolean? = null
        if (isMember) {
            // Skip the self-copy read (a signer prompt for a remote signer) when the cache already proves an intro.
            if (hasIntro != true) {
                hasIntro = runCatching { media.loadSelfCopy(signer, ctx, blindingKey())?.hasIntro }.getOrNull()
            }
            if (ctx.cfg.coordinator != null) {
                val refreshed = runCatching { members.refresh(ctx, signer) }.getOrDefault(false)
                if (refreshed) {
                    val entry = members.cachedDirectory(owner, ctx.coordinate).firstOrNull { it.pubkey == owner }
                    if (entry != null && today.cypherpunk.nostrautica.domain.media.SelfCopy.hasIntro(entry.media, entry.introText)) hasIntro = true
                    processed = if (entry != null) entry.aiProfile != null else if (hasIntro == true) false else null
                    profileEmpty = entry?.let { !ReadinessRules.hasAnythingToMatchOn(it) }
                    if (ctx.cfg.matching) matches = members.cachedMatches(owner, ctx.coordinate) != null
                }
            }
        }
        val parts = Parts(roleName(role), signerHoldsKey, backup, hasIntro, profileEmpty, processed, matches)
        val r = derive(owner, ctx, parts, latch)
        val now = System.currentTimeMillis()
        commit(owner, ctx.coordinate, r, latch, now)
        return r to now
    }

    companion object {
        const val VERSION = 2
        const val PROCESSING_STAGE = "process_attendee"
        const val KEY_BACKUP_D = "nostrautica:keybackup"
    }
}
