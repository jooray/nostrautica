package today.cypherpunk.nostrautica.domain.media

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.domain.EventContext
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.domain.join.AuthoredProfile
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.Media
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.ProfileSubmissionContent
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.protocol.jsonObjectOf
import today.cypherpunk.nostrautica.protocol.nowSec

/** An error whose text is a catalog key the UI renders in the user's language. */
class UserFacingError(val key: String, val params: Map<String, Any> = emptyMap()) : Exception(key)

/** The attendee's own 31602 for one event (submit.ts SelfCopy). */
@Serializable
data class SelfCopy(
    val profile: AttendeeProfile? = null,
    val media: List<MediaDescriptor> = emptyList(),
    val introText: String? = null,
    val rev: Long? = null,
    val correctionRev: Long? = null,
) {
    /** An intro is a recording (media kind "intro") OR an authored text intro (UX-O5). */
    val hasIntro: Boolean get() = Companion.hasIntro(media, introText)

    companion object {
        fun hasIntro(media: List<MediaDescriptor>?, introText: String?): Boolean =
            (media ?: emptyList()).any { it.kind == "intro" } || !introText.isNullOrBlank()
    }
}

/** The cross-event reuse library (the single `a:null` 31602). [known] false = unread, never publish over it. */
data class ReuseLibrary(val media: List<MediaDescriptor>, val texts: List<String>, val at: Map<String, Long>, val known: Boolean)

enum class Outcome { PUBLISHED, QUEUED, SKIPPED }

/** submit.ts SubmitOutcome: the 21601 is the one that matters. */
data class SubmitOutcome(val submission: Outcome, val selfCopy: Outcome, val library: Outcome) {
    /** Worst case: QUEUED if anything is still local (or the library write was skipped). */
    val aggregate: Outcome get() =
        if (submission == Outcome.QUEUED || selfCopy == Outcome.QUEUED || library != Outcome.PUBLISHED) Outcome.QUEUED else Outcome.PUBLISHED
}

fun Nostr.PublishResult.outcome() = if (this is Nostr.PublishResult.Published) Outcome.PUBLISHED else Outcome.QUEUED

/**
 * Intro media and the self-copy (media/submit.ts): record → AES-GCM encrypt →
 * Blossom preflight/upload/mirror → a new 21601 to E_inbox + the 31602 self-copy +
 * the reuse-library entry. The descriptor (with its key) only ever travels inside
 * encrypted events.
 *
 * Kept from the PWA because each was a production incident:
 * - `rev` is a persisted, monotonic high-water mark; a failed relay read can only
 *   fail to ADVANCE it, never roll it back to 0 (which the coordinator discards);
 * - the library publish is skipped (not blanked) when the current one can't be read;
 * - a submission is validated against the coordinator's own schema before signing;
 * - the authored profile survives a media submission (self-copy → cache → 31603).
 *
 * Decrypts are memoized by event `created_at`, so a remote signer is not asked to
 * decrypt the same self-copy twice.
 */
class IntroMedia(
    private val nostr: Nostr,
    private val cache: Cache,
    private val accounts: Accounts,
    private val members: Members,
    val blossom: BlossomClient,
) {
    private val lastTimestamp = HashMap<String, Long>()

    private val revs = RevCounters(cache)

    private fun selfKey(c: String) = "selfcopy:$c"

    // ── Self-copy cache ─────────────────────────────────────────────────────

    suspend fun cachedSelfCopy(owner: String, coordinate: String): SelfCopy? = cache.get(owner, selfKey(coordinate), SelfCopy.serializer())

    fun observeSelfCopy(owner: String, coordinate: String): Flow<SelfCopy?> = cache.observe(owner, selfKey(coordinate), SelfCopy.serializer())

    /** Write through a self-copy just published and raise the rev high-water marks. */
    suspend fun cacheSelfCopy(owner: String, coordinate: String, self: SelfCopy, at: Long) {
        cache.put(owner, selfKey(coordinate), SelfCopy.serializer(), self, at)
        self.rev?.let { revs.raise(owner, coordinate, it) }
        self.correctionRev?.let { revs.raiseCorrection(owner, coordinate, it) }
    }

    suspend fun nextRev(owner: String, coordinate: String, observed: Long?): Long = revs.next(owner, coordinate, observed)

    /** created_at strictly increasing per d-slot (submit.ts nextReplaceableTimestamp). */
    private suspend fun nextTimestamp(owner: String, d: String, persistedAt: Long?): Long {
        val store = accounts.monotonicCreatedAt(Kinds.MY_PROFILE, owner, d)
        synchronized(lastTimestamp) {
            val next = maxOf(store, (persistedAt ?: 0) + 1, (lastTimestamp[d] ?: 0) + 1)
            lastTimestamp[d] = next
            return next
        }
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /**
     * The own 31602 for [ctx]. Relays first (a must-not-miss read: the next
     * submission is built from it), falling back to the persisted copy when they
     * say nothing. [network] false = phone only.
     */
    suspend fun loadSelfCopy(signer: NostrSigner, ctx: EventContext, blindingKey: ByteArray, network: Boolean = true): SelfCopy? {
        val pk = signer.pubkey
        val d = ProtocolCrypto.blindedD(blindingKey, ctx.coordinate, pk)
        if (network) runCatching { nostr.fetch(Relays.DEFAULT, Filter(kinds = listOf(Kinds.MY_PROFILE), authors = listOf(pk), tags = mapOf("d" to listOf(d)))) }
        val latest = nostr.store.latest(Kinds.MY_PROFILE, pk, d)
        if (latest != null) {
            val cached = cache.getRaw(pk, selfKey(ctx.coordinate))
            if (cached != null && cached.at >= latest.createdAt) return cachedSelfCopy(pk, ctx.coordinate)
            runCatching { parseSelfCopy(signer.nip44Decrypt(pk, latest.content)) }.getOrNull()?.let { self ->
                cache.put(pk, selfKey(ctx.coordinate), SelfCopy.serializer(), self, latest.createdAt)
                return self
            }
        }
        return cachedSelfCopy(pk, ctx.coordinate)
    }

    /**
     * Current authored state, widening the search rather than degrading to blank:
     * self-copy (relays) → persisted self-copy → the published 31603 entry.
     */
    suspend fun loadAuthoredState(signer: NostrSigner, ctx: EventContext, blindingKey: ByteArray): SelfCopy? {
        loadSelfCopy(signer, ctx, blindingKey)?.let { return it }
        val entry = ownDirectoryEntry(signer, ctx, refresh = true) ?: return null
        return SelfCopy(entry.profile, entry.media, entry.introText, rev = null)
    }

    suspend fun ownDirectoryEntry(signer: NostrSigner, ctx: EventContext, refresh: Boolean): DirectoryEntryContent? {
        val pk = signer.pubkey
        if (refresh) runCatching { members.refresh(ctx, signer) }
        return members.cachedDirectory(pk, ctx.coordinate).firstOrNull { it.pubkey == pk }
    }

    suspend fun cachedLibrary(owner: String): ReuseLibrary? {
        val media = cache.get(owner, LIB_MEDIA, ListSerializer(MediaDescriptor.serializer())) ?: return null
        val texts = cache.get(owner, LIB_TEXTS, ListSerializer(String.serializer())) ?: emptyList()
        val at = cache.get(owner, LIB_AT, MapSerializer(String.serializer(), Long.serializer())) ?: emptyMap()
        return ReuseLibrary(media, texts, at, known = false)
    }

    /** The reuse library (`d = blindedDLiteral(bk, "library")`). `known` = the relays actually answered. */
    suspend fun loadLibraryFull(signer: NostrSigner, blindingKey: ByteArray): ReuseLibrary {
        val pk = signer.pubkey
        val d = ProtocolCrypto.blindedDLiteral(blindingKey, "library")
        val r = runCatching { nostr.fetch(Relays.DEFAULT, Filter(kinds = listOf(Kinds.MY_PROFILE), authors = listOf(pk), tags = mapOf("d" to listOf(d)))) }.getOrNull()
        val latest = nostr.store.latest(Kinds.MY_PROFILE, pk, d)
            ?: return ReuseLibrary(emptyList(), emptyList(), emptyMap(), known = (r?.answered ?: 0) > 0)
        val cachedRow = cache.getRaw(pk, LIB_MEDIA)
        if (cachedRow != null && cachedRow.at >= latest.createdAt) cachedLibrary(pk)?.let { return it.copy(known = true) }
        val lib = runCatching { parseLibrary(signer.nip44Decrypt(pk, latest.content)) }.getOrNull()
            ?: return ReuseLibrary(emptyList(), emptyList(), emptyMap(), known = false)
        writeLibraryCache(pk, lib, latest.createdAt)
        return lib
    }

    private suspend fun writeLibraryCache(pk: String, lib: ReuseLibrary, at: Long) {
        cache.put(pk, LIB_MEDIA, ListSerializer(MediaDescriptor.serializer()), lib.media, at)
        cache.put(pk, LIB_TEXTS, ListSerializer(String.serializer()), lib.texts, at)
        cache.put(pk, LIB_AT, MapSerializer(String.serializer(), Long.serializer()), lib.at, at)
    }

    // ── Library writes ──────────────────────────────────────────────────────

    /** Append to the reuse library (dedup by `x`; texts re-added move to newest; capped). */
    suspend fun addToLibrary(signer: NostrSigner, blindingKey: ByteArray, media: List<MediaDescriptor>, texts: List<String>): Outcome {
        val add = texts.map { it.trim() }.filter { it.isNotEmpty() }
        if (media.isEmpty() && add.isEmpty()) return Outcome.PUBLISHED
        val pk = signer.pubkey
        val existing = loadLibraryFull(signer, blindingKey)
        if (!existing.known) return Outcome.SKIPPED
        val prior = cachedLibrary(pk)
        val merged = LibraryMerge.merge(prior, existing, media, add, nowSec())
        val d = ProtocolCrypto.blindedDLiteral(blindingKey, "library")
        val cipher = signer.nip44Encrypt(pk, libraryJson(merged))
        val created = nextTimestamp(pk, d, cache.getRaw(pk, LIB_MEDIA)?.at)
        val ev = signer.sign(UnsignedEvent(pk, created, Kinds.MY_PROFILE, listOf(listOf("d", d)), cipher))
        val res = nostr.publish(ev, Relays.DEFAULT, pk, "library")
        writeLibraryCache(pk, merged, ev.createdAt)
        return res.outcome()
    }

    // ── Upload ──────────────────────────────────────────────────────────────

    /** Encrypted media: event 31600 servers ∪ defaults. Never the user's 10063 (several 415 on ciphertext). */
    fun resolveBlossomServers(ctx: EventContext): List<String> =
        BlossomClient.union(ctx.cfg.blossom, Relays.BLOSSOM).filter(BlossomClient::isAcceptedBlossomUrl)

    /** The user's BUD-03 list (kind 10063), https only; refetched at most every 30 min. */
    suspend fun userBlossomServers(pubkey: String): List<String> {
        val f = Filter(kinds = listOf(Kinds.BLOSSOM_SERVERS), authors = listOf(pubkey))
        if (!cache.isFresh("10063:$pubkey", 30 * 60_000L)) {
            runCatching { nostr.fetch(Relays.READ, f) }
            cache.markFetched("10063:$pubkey")
        }
        return nostr.store.latest(Kinds.BLOSSOM_SERVERS, pubkey)?.tagValues("server")?.filter(BlossomClient::isAcceptedBlossomUrl) ?: emptyList()
    }

    /** Encrypt + preflight + upload + mirror; returns the finalized (https-validated) descriptor. */
    suspend fun uploadMedia(signer: NostrSigner, ctx: EventContext, data: ByteArray, mime: String, kind: String, durationSec: Double): MediaDescriptor {
        val enc = Media.encrypt(kind, data, mime, durationSec)
        val d = enc.descriptor
        val servers = resolveBlossomServers(ctx)
        val checks = coroutineScope { servers.map { s -> async { blossom.preflight(signer, s, d.x, d.size, OCTET) } }.map { it.await() } }
        // Explicit OKs first; an unanswered preflight (status 0) only as a fallback.
        val accepting = checks.filter { it.ok }.map { it.server } + checks.filter { !it.ok && it.status == 0 }.map { it.server }
        if (accepting.isEmpty()) {
            throw java.io.IOException("No Blossom server accepted the upload (" + checks.joinToString("; ") { "${it.server}: ${it.message ?: it.status}" } + ")")
        }
        val up = blossom.uploadAndMirror(signer, accepting, enc.ciphertext, OCTET)
        return d.copy(url = up.urls.take(Limits.MAX_MEDIA_URLS)).also { it.validate() }
    }

    /** Reuse a library clip here: mirror it onto this event's servers, or a fresh re-keyed copy. */
    suspend fun prepareReuse(signer: NostrSigner, ctx: EventContext, d: MediaDescriptor, fresh: Boolean): MediaDescriptor {
        val servers = resolveBlossomServers(ctx)
        if (fresh) {
            val ct = blossom.download(d.url, d.x, d.size)
            val re = Media.freshCopy(d, ct, emptyList())
            val up = blossom.uploadAndMirror(signer, servers, re.ciphertext, OCTET)
            return re.descriptor.copy(url = up.urls.take(Limits.MAX_MEDIA_URLS)).also { it.validate() }
        }
        val extra = mutableListOf<String>()
        for (s in servers) {
            val url = blossom.mirror(signer, s, d.url.first(), d.x)
            if (url != null && url !in d.url) extra += url
        }
        return d.copy(url = (d.url + extra).distinct().take(Limits.MAX_MEDIA_URLS)).also { it.validate() }
    }

    // ── Submission ──────────────────────────────────────────────────────────

    /** A 21601 + the 31602 + the library entry (submit.ts submitProfileAndMedia). */
    suspend fun submitProfileAndMedia(
        signer: NostrSigner,
        ctx: EventContext,
        profile: AttendeeProfile,
        media: List<MediaDescriptor>,
        blindingKey: ByteArray,
        introText: String? = null,
    ): SubmitOutcome {
        val pk = signer.pubkey
        val text = introText?.trim()?.take(Limits.MAX_INTRO_TEXT)?.ifEmpty { null }
        val normalized = AuthoredProfile.normalize(profile).profile
        val prevSelf = runCatching { loadSelfCopy(signer, ctx, blindingKey) }.getOrNull()
        val rev = nextRev(pk, ctx.coordinate, prevSelf?.rev)
        val submission = ProfileSubmissionContent(rev = rev, profile = normalized, media = media.take(Limits.MAX_SUBMISSION_MEDIA), introText = text)
        assertSubmittable(submission)
        val wrap = accounts.wrap(ctx.cfg.inbox, Kinds.PROFILE_SUBMISSION, Wire.json.encodeToString(ProfileSubmissionContent.serializer(), submission), listOf(listOf("a", ctx.coordinate)))

        // Carry the correction rev forward: every submission REPLACES this 31602 (audit A-5).
        val carried = prevSelf?.correctionRev ?: revs.correctionFloor(pk, ctx.coordinate)
        val selfEvent = signSelfCopy(signer, ctx, blindingKey, SelfCopy(normalized, media, text, rev, carried))

        return coroutineScope {
            val sub = async { nostr.publish(wrap, ctx.relays, pk, "intro").outcome() }
            val self = async {
                nostr.publish(selfEvent, Relays.DEFAULT, pk, "self-copy").outcome().also {
                    // Durable either way (relay or outbox): write through before anything re-reads.
                    cacheSelfCopy(pk, ctx.coordinate, SelfCopy(normalized, media, text, rev, carried), selfEvent.createdAt)
                }
            }
            val lib = async { runCatching { addToLibrary(signer, blindingKey, media, listOfNotNull(text)) }.getOrDefault(Outcome.SKIPPED) }
            SubmitOutcome(sub.await(), self.await(), lib.await())
        }
    }

    /** Encrypt-to-self and sign a per-event 31602 (blinded d over the blinding key, NIP §6.6). */
    suspend fun signSelfCopy(signer: NostrSigner, ctx: EventContext, blindingKey: ByteArray, self: SelfCopy): NostrEvent {
        val pk = signer.pubkey
        val selfD = ProtocolCrypto.blindedD(blindingKey, ctx.coordinate, pk)
        val cipher = signer.nip44Encrypt(pk, selfCopyJson(ctx.coordinate, self.rev ?: 0, self.profile, self.media, self.introText, self.correctionRev))
        val created = nextTimestamp(pk, selfD, cache.getRaw(pk, selfKey(ctx.coordinate))?.at)
        return signer.sign(UnsignedEvent(pk, created, Kinds.MY_PROFILE, listOf(listOf("d", selfD)), cipher))
    }

    fun assertSubmittable(s: ProfileSubmissionContent) = Companion.assertSubmittable(s)

    /**
     * The next 21608 correction rev, monotonic across devices (audit A-5): floor from
     * the relay-backed self-copy AND the local mark. [Claim.record] writes it into the
     * self-copy so the next device sees it.
     */
    inner class Claim(val rev: Long, private val signer: NostrSigner, private val ctx: EventContext, private val bk: ByteArray, private val self: SelfCopy?) {
        suspend fun record() {
            val pk = signer.pubkey
            val selfD = ProtocolCrypto.blindedD(bk, ctx.coordinate, pk)
            val merged = (self ?: SelfCopy()).copy(correctionRev = rev)
            val json = JsJson.stringify(buildJsonObject {
                put("v", Wire.PROTOCOL_VERSION)
                put("a", ctx.coordinate)
                merged.profile?.let { put("profile", Wire.json.encodeToJsonElement(AttendeeProfile.serializer(), it)) }
                put("media", JsonArray(merged.media.map { Wire.json.encodeToJsonElement(MediaDescriptor.serializer(), it) }))
                merged.introText?.takeIf { it.isNotEmpty() }?.let { put("intro_text", it) }
                merged.rev?.let { put("rev", it) }
                put("correction_rev", rev)
            })
            val cipher = signer.nip44Encrypt(pk, json)
            val created = nextTimestamp(pk, selfD, cache.getRaw(pk, selfKey(ctx.coordinate))?.at)
            val ev = signer.sign(UnsignedEvent(pk, created, Kinds.MY_PROFILE, listOf(listOf("d", selfD)), cipher))
            nostr.publish(ev, Relays.DEFAULT, pk, "self-copy")
            cacheSelfCopy(pk, ctx.coordinate, merged, ev.createdAt)
        }
    }

    suspend fun claimCorrectionRev(signer: NostrSigner, ctx: EventContext, bk: ByteArray): Claim {
        val pk = signer.pubkey
        val self = runCatching { loadSelfCopy(signer, ctx, bk) }.getOrNull()
        val rev = revs.claimCorrection(pk, ctx.coordinate, self?.correctionRev)
        return Claim(rev, signer, ctx, bk, self)
    }

    /** The NIP-09 target of the own self-copy (withdrawal). */
    fun selfCopyAddress(pubkey: String, blindingKey: ByteArray, coordinate: String) =
        "${Kinds.MY_PROFILE}:$pubkey:${ProtocolCrypto.blindedD(blindingKey, coordinate, pubkey)}"

    companion object {
        const val OCTET = "application/octet-stream"
        const val LIB_MEDIA = "medialib"
        const val LIB_TEXTS = "textlib"
        const val LIB_AT = "medialib-at"

        /** The coordinator drops an invalid 21601 forever while the app says "Saved": fail here instead. */
        fun assertSubmittable(s: ProfileSubmissionContent) {
            try {
                s.validate()
            } catch (e: Wire.InvalidPayload) {
                val msg = e.message ?: "invalid"
                val field = msg.substringBefore(' ').ifEmpty { "profile" }
                throw UserFacingError("submit.error.invalid", mapOf("field" to field, "reason" to msg.substringAfter(' ', msg)))
            }
        }

        private fun mediaJson(m: List<MediaDescriptor>) = JsonArray(m.map { Wire.json.encodeToJsonElement(MediaDescriptor.serializer(), it) })

        /** The per-event 31602 plaintext. */
        fun selfCopyJson(coordinate: String, rev: Long, profile: AttendeeProfile?, media: List<MediaDescriptor>, introText: String?, correctionRev: Long?): String =
            JsJson.stringify(buildJsonObject {
                put("v", Wire.PROTOCOL_VERSION)
                put("a", coordinate)
                put("rev", rev)
                profile?.let { put("profile", Wire.json.encodeToJsonElement(AttendeeProfile.serializer(), it)) }
                put("media", mediaJson(media))
                introText?.let { put("intro_text", it) }
                correctionRev?.let { put("correction_rev", it) }
            })

        /** The library plaintext: `a: null`, a `media_at` sidecar, texts only when present. */
        fun libraryJson(lib: ReuseLibrary): String = JsJson.stringify(buildJsonObject {
            put("v", Wire.PROTOCOL_VERSION)
            put("a", JsonNull)
            put("media", mediaJson(lib.media))
            put("media_at", JsonObject(lib.at.mapValues { JsonPrimitive(it.value) }))
            if (lib.texts.isNotEmpty()) put("intro_texts", JsonArray(lib.texts.map(::JsonPrimitive)))
        })

        private fun numberOf(e: Any?): Long? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }?.toLong()

        private fun mediaOf(e: Any?): List<MediaDescriptor> =
            (e as? JsonArray)?.mapNotNull { runCatching { Wire.json.decodeFromJsonElement(MediaDescriptor.serializer(), it) }.getOrNull() } ?: emptyList()

        fun parseSelfCopy(json: String): SelfCopy? {
            val o = jsonObjectOf(json) ?: return null
            return SelfCopy(
                profile = o["profile"]?.let { runCatching { Wire.json.decodeFromJsonElement(AttendeeProfile.serializer(), it) }.getOrNull() },
                media = mediaOf(o["media"]),
                introText = (o["intro_text"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
                rev = numberOf(o["rev"]),
                correctionRev = numberOf(o["correction_rev"]),
            )
        }

        fun parseLibrary(json: String): ReuseLibrary? {
            val o = jsonObjectOf(json) ?: return null
            val texts = (o["intro_texts"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
            val at = (o["media_at"] as? JsonObject)?.mapNotNull { (k, v) -> numberOf(v)?.let { k to it } }?.toMap() ?: emptyMap()
            return ReuseLibrary(mediaOf(o["media"]), texts, at, known = true)
        }
    }
}

/** The append-only library merge (submit.ts addToLibrary), pure for tests. */
object LibraryMerge {
    fun merge(prior: ReuseLibrary?, existing: ReuseLibrary, media: List<MediaDescriptor>, texts: List<String>, now: Long): ReuseLibrary {
        // Union with this device's last copy too: the library only grows, so a union can restore but never resurrect.
        val byHash = LinkedHashMap<String, MediaDescriptor>()
        for (d in (prior?.media ?: emptyList()) + existing.media + media) byHash[d.x] = d
        val mergedMedia = byHash.values.toList()
        // Stamp only what is genuinely new: the date says when a clip was MADE.
        val at = LinkedHashMap<String, Long>()
        at.putAll(prior?.at ?: emptyMap())
        at.putAll(existing.at)
        for (d in mergedMedia) if (at[d.x] == null) at[d.x] = now
        val mergedTexts = ((prior?.texts ?: emptyList()).filter { it !in existing.texts } + existing.texts).toMutableList()
        for (t in texts) {
            mergedTexts.remove(t)
            mergedTexts += t
        }
        return ReuseLibrary(mergedMedia, mergedTexts.takeLast(Limits.MAX_LIBRARY_TEXTS), at, known = true)
    }
}
