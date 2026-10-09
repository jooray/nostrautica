package today.cypherpunk.nostrautica.domain

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import today.cypherpunk.nostrautica.protocol.EckVersion
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.signer.SecureStore

/** What this device holds for one event (events/keystore.ts `EventKeys`). */
@Serializable
data class EventKeys(
    val coordinate: String,
    val role: String,
    val eck: List<EckVersion> = emptyList(),
    val eidNsecHex: String? = null,
    val einboxNsecHex: String? = null,
    val priorEinboxNsecs: List<String>? = null,
    val coordinatorGen: Int? = null,
) {
    val isOrganizer: Boolean get() = role == "organizer" && eidNsecHex != null && einboxNsecHex != null

    /** The highest ECK version held. */
    val current: EckVersion? get() = eck.maxByOrNull { it.id }

    fun eckFor(id: Int?): ByteArray? = (if (id != null) eck.firstOrNull { it.id == id } else null)?.bytes()

    companion object {
        /** keystore.ts mergeEventKeys: never drop a secret, a role or a retired inbox. */
        fun merge(primary: EventKeys, fallback: EventKeys): EventKeys {
            val byId = LinkedHashMap<Int, EckVersion>()
            fallback.eck.forEach { byId[it.id] = it }
            primary.eck.forEach { byId[it.id] = it }
            val prior = ((primary.priorEinboxNsecs ?: emptyList()) + (fallback.priorEinboxNsecs ?: emptyList())).distinct()
            return EventKeys(
                coordinate = primary.coordinate,
                role = if (primary.role == "organizer" || fallback.role == "organizer") "organizer" else primary.role,
                eck = byId.values.sortedBy { it.id },
                eidNsecHex = primary.eidNsecHex ?: fallback.eidNsecHex,
                einboxNsecHex = primary.einboxNsecHex ?: fallback.einboxNsecHex,
                priorEinboxNsecs = prior.ifEmpty { null },
                coordinatorGen = maxOf(primary.coordinatorGen ?: 0, fallback.coordinatorGen ?: 0).takeIf { it > 0 },
            )
        }
    }
}

/**
 * Event key custody (events/keystore.ts), owner-scoped, in [SecureStore] (Android
 * Keystore-wrapped). Keys of a logged-out account are self-encrypted with that
 * account's signer ([lockForLogout]) and come back on its next login, exactly as
 * the PWA does, so a second person signing in on the same phone gets nothing.
 */
class EventKeysStore(private val secure: SecureStore) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val lock = Mutex()
    private val _changes = MutableStateFlow(0)
    /** Bumps whenever custody changes, so screens re-derive roles. */
    val changes: StateFlow<Int> get() = _changes

    private fun name(owner: String, coordinate: String) = "ek|$owner|$coordinate"
    private fun lockedName(owner: String, coordinate: String) = "ekl|$owner|$coordinate"

    fun get(owner: String, coordinate: String): EventKeys? =
        secure.get(name(owner, coordinate))?.let { runCatching { json.decodeFromString(EventKeys.serializer(), it) }.getOrNull() }

    fun list(owner: String): List<EventKeys> =
        secure.keys("ek|$owner|").mapNotNull { k -> secure.get(k)?.let { runCatching { json.decodeFromString(EventKeys.serializer(), it) }.getOrNull() } }

    suspend fun save(owner: String, keys: EventKeys) = lock.withLock {
        secure.put(name(owner, keys.coordinate), json.encodeToString(EventKeys.serializer(), keys))
        _changes.value++
    }

    suspend fun delete(owner: String, coordinate: String) = lock.withLock {
        secure.put(name(owner, coordinate), null)
        _changes.value++
    }

    /** Union new ECK versions in; a stale grant never downgrades custody. */
    suspend fun addEckVersions(owner: String, coordinate: String, versions: List<EckVersion>, role: String = "attendee"): EventKeys {
        // The role is set only when the record is new, as in keystore.ts: an
        // attendee-role grant never downgrades an organizer.
        val existing = get(owner, coordinate) ?: EventKeys(coordinate, role)
        val updated = existing.copy(eck = (existing.eck + versions).associateBy { it.id }.values.sortedBy { it.id })
        save(owner, updated)
        return updated
    }

    suspend fun applyOrganizerGrant(owner: String, coordinate: String, eck: List<EckVersion>, eidNsecHex: String, einboxNsecHex: String): EventKeys {
        val existing = get(owner, coordinate) ?: EventKeys(coordinate, "organizer")
        val updated = existing.copy(
            role = "organizer",
            eck = (existing.eck + eck).associateBy { it.id }.values.sortedBy { it.id },
            eidNsecHex = eidNsecHex,
            einboxNsecHex = einboxNsecHex,
        )
        save(owner, updated)
        return updated
    }

    /** Self-encrypt every record with the account's signer and drop the plaintext. */
    suspend fun lockForLogout(owner: String, signer: NostrSigner) {
        for (rec in list(owner)) {
            runCatching {
                var toLock = rec
                secure.get(lockedName(owner, rec.coordinate))?.let { prior ->
                    val restored = json.decodeFromString(EventKeys.serializer(), signer.nip44Decrypt(owner, prior))
                    toLock = EventKeys.merge(rec, restored)
                }
                secure.put(lockedName(owner, rec.coordinate), signer.nip44Encrypt(owner, json.encodeToString(EventKeys.serializer(), toLock)))
                secure.put(name(owner, rec.coordinate), null)
            }
        }
        _changes.value++
    }

    /** Restore what [lockForLogout] locked. Returns false if some record stayed locked. */
    suspend fun unlockForLogin(owner: String, signer: NostrSigner): Boolean {
        var complete = true
        for (k in secure.keys("ekl|$owner|")) {
            val coordinate = k.removePrefix("ekl|$owner|")
            runCatching {
                val restored = json.decodeFromString(EventKeys.serializer(), signer.nip44Decrypt(owner, secure.get(k)!!))
                val merged = get(owner, coordinate)?.let { EventKeys.merge(it, restored) } ?: restored
                save(owner, merged.copy(coordinate = coordinate))
                secure.put(k, null)
            }.onFailure { complete = false }
        }
        return complete
    }
}
