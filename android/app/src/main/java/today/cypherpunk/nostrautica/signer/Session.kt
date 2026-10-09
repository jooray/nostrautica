package today.cypherpunk.nostrautica.signer

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.LocalSigner
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.Nip49
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.Secp

/**
 * The signed-in account (signer/session.svelte.ts). One active account at a time;
 * everything the app stores is scoped by its pubkey, so switching accounts on one
 * phone is safe. The secret material (a local key, a NIP-46 client session) is
 * kept in [SecureStore], never in plain preferences.
 */
class Session(
    private val context: Context,
    private val secure: SecureStore,
    private val pool: RelayPool,
    val bridge: SignerIntentBridge,
) {
    enum class Method { LOCAL, NIP55, NIP46 }

    data class Account(val pubkey: String, val signer: NostrSigner, val method: Method) {
        val npub: String get() = Nip19.npub(pubkey)
    }

    @Serializable
    private data class Stored(
        val method: String,
        val pubkey: String,
        val localSk: String? = null,
        val signerPackage: String? = null,
        val nip46: Nip46Signer.Session? = null,
        val fresh: Boolean = false,
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val _account = MutableStateFlow<Account?>(null)
    val account: StateFlow<Account?> get() = _account

    private val _needsBackup = MutableStateFlow(false)
    /** A key this app generated that the user hasn't saved anywhere yet. */
    val needsBackup: StateFlow<Boolean> get() = _needsBackup

    /** Restore on start. Local and NIP-55 are instant; NIP-46 restores without a network round trip. */
    fun restore() {
        val stored = secure.get(KEY)?.let { runCatching { json.decodeFromString(Stored.serializer(), it) }.getOrNull() } ?: return
        val signer: NostrSigner? = when (stored.method) {
            "local" -> stored.localSk?.let { LocalSigner(Bytes.fromHex(it)) }
            "nip55" -> stored.signerPackage?.let { Nip55Signer(context, stored.pubkey, it, bridge) }
            "nip46" -> stored.nip46?.let { Nip46Signer.restore(pool, it) }
            else -> null
        }
        if (signer == null || signer.pubkey != stored.pubkey) { secure.put(KEY, null); return }
        _needsBackup.value = stored.fresh
        _account.value = Account(stored.pubkey, signer, Method.valueOf(stored.method.uppercase()))
    }

    private fun save(s: Stored) = secure.put(KEY, json.encodeToString(Stored.serializer(), s))

    /** A brand-new identity for someone who doesn't use Nostr (invisible onboarding). */
    fun createLocalKey(): Account = useLocalKey(Secp.generateSecret(), fresh = true)

    /** nsec, hex, or NIP-49 ncryptsec (with [passphrase]). */
    fun importKey(input: String, passphrase: String? = null): Account {
        val s = input.trim()
        val sk = when {
            s.startsWith("nsec1") -> Nip19.decodeNsec(s)
            s.startsWith("ncryptsec1") -> Nip49.decrypt(s, passphrase ?: throw IllegalArgumentException("passphrase required"))
            Regex("^[0-9a-fA-F]{64}$").matches(s) -> Bytes.fromHex(s.lowercase())
            else -> throw IllegalArgumentException("not a key")
        }
        require(Secp.isValidSecret(sk)) { "not a valid key" }
        return useLocalKey(sk, fresh = false)
    }

    private fun useLocalKey(sk: ByteArray, fresh: Boolean): Account {
        val signer = LocalSigner(sk)
        save(Stored("local", signer.pubkey, localSk = Bytes.toHex(sk), fresh = fresh))
        _needsBackup.value = fresh
        return Account(signer.pubkey, signer, Method.LOCAL).also { _account.value = it }
    }

    suspend fun loginNip55(signerPackage: String): Account {
        val (pubkey, pkg) = Nip55Signer.connect(bridge, signerPackage)
        save(Stored("nip55", pubkey, signerPackage = pkg))
        return Account(pubkey, Nip55Signer(context, pubkey, pkg, bridge), Method.NIP55).also { _account.value = it }
    }

    fun adoptNip46(signer: Nip46Signer): Account {
        save(Stored("nip46", signer.pubkey, nip46 = signer.session))
        return Account(signer.pubkey, signer, Method.NIP46).also { _account.value = it }
    }

    fun markBackedUp() {
        val stored = secure.get(KEY)?.let { json.decodeFromString(Stored.serializer(), it) } ?: return
        save(stored.copy(fresh = false))
        _needsBackup.value = false
    }

    /** The raw key, for the backup screen. Null for remote signers. */
    fun exportSecret(): ByteArray? = (account.value?.signer as? LocalSigner)?.secret()

    fun logout() {
        (account.value?.signer as? Nip46Signer)?.close()
        secure.put(KEY, null)
        _needsBackup.value = false
        _account.value = null
    }

    companion object {
        private const val KEY = "account"
    }
}
