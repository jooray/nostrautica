package today.cypherpunk.nostrautica.protocol

/**
 * What the app asks of a user's signer (signer/types.ts `AppSigner`): sign, and
 * NIP-44 encrypt/decrypt with a peer. NIP-04 is banned project-wide.
 *
 * Implementations: [LocalSigner] (a key on this phone), and in the app NIP-55
 * (Amber and other signer apps) and NIP-46 (remote bunkers).
 */
interface NostrSigner {
    val pubkey: String

    /** True when the key is on this device, so operations are instant and silent. */
    val isLocal: Boolean

    suspend fun sign(event: UnsignedEvent): NostrEvent

    suspend fun nip44Encrypt(peerPubkey: String, plaintext: String): String

    suspend fun nip44Decrypt(peerPubkey: String, ciphertext: String): String

    fun template(kind: Int, content: String, tags: List<List<String>> = emptyList(), createdAt: Long = nowSec()) =
        UnsignedEvent(pubkey, createdAt, kind, tags, content)
}

class LocalSigner(private val sk: ByteArray) : NostrSigner {
    init {
        require(Secp.isValidSecret(sk)) { "invalid secret key" }
    }

    override val pubkey: String = Secp.pubkeyHex(sk)
    override val isLocal: Boolean = true

    /** The raw secret, for backups and the blinding key. Never log it. */
    fun secret(): ByteArray = sk.copyOf()

    override suspend fun sign(event: UnsignedEvent): NostrEvent {
        require(event.pubkey == pubkey) { "event pubkey does not match the signer" }
        return event.signWith(sk)
    }

    fun signNow(event: UnsignedEvent): NostrEvent = event.signWith(sk)

    override suspend fun nip44Encrypt(peerPubkey: String, plaintext: String): String =
        Nip44.encryptTo(sk, peerPubkey, plaintext)

    override suspend fun nip44Decrypt(peerPubkey: String, ciphertext: String): String =
        Nip44.decryptFrom(sk, peerPubkey, ciphertext)

    companion object {
        fun generate() = LocalSigner(Secp.generateSecret())
    }
}
