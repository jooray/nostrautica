package today.cypherpunk.nostrautica.protocol

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The protocol-specific constructions of crypto.ts. Everything symmetric is NIP-44 or AES-GCM. */
object ProtocolCrypto {
    fun generateEck(): ByteArray = Bytes.random(32)

    // ── Blinded d-tags (spec §6.6) ──────────────────────────────────────────
    // hex(HMAC-SHA256(key, message))[0..32]. blindedD and blindedDLiteral share one
    // key and no tag prefix: see the domain-separation note in crypto.ts before
    // adding a literal.

    private fun blinded(key: ByteArray, message: String): String =
        Bytes.toHex(Bytes.hmacSha256(key, Bytes.utf8(message))).substring(0, 32)

    fun blindedD(key: ByteArray, coordinate: String, attendeePubkey: String): String =
        blinded(key, "$coordinate|$attendeePubkey")

    fun blindedDLiteral(key: ByteArray, literal: String): String = blinded(key, literal)

    fun talkD(eck: ByteArray, coordinate: String, speaker: String, talkD: String): String =
        blindedDLiteral(eck, "talk|$coordinate|$speaker|$talkD")

    // ── AES-256-GCM media (spec §6.2): whole-file, 12-byte IV, tag appended ──

    class MediaCipher(val ciphertext: ByteArray, val key: ByteArray, val nonce: ByteArray)

    fun aesGcmEncrypt(plaintext: ByteArray, key: ByteArray = Bytes.random(32), nonce: ByteArray = Bytes.random(12)): MediaCipher {
        require(key.size == 32) { "AES-GCM key must be 32 bytes" }
        require(nonce.size == 12) { "AES-GCM nonce must be 12 bytes" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return MediaCipher(c.doFinal(plaintext), key, nonce)
    }

    fun aesGcmDecrypt(ciphertext: ByteArray, key: ByteArray, nonce: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return c.doFinal(ciphertext)
    }

    // ── Invite proofs (NIP §7) ──────────────────────────────────────────────

    private const val INVITE_PROOF_TAG = "nostrautica-invite-v2"
    private const val CHAT_DEVICE_PROOF_TAG = "nostrautica-chat-device-v2"

    private fun stringArray(vararg parts: Any): String {
        val sb = StringBuilder("[")
        parts.forEachIndexed { i, p ->
            if (i > 0) sb.append(',')
            when (p) {
                is String -> JsJson.appendQuoted(sb, p)
                is Long, is Int -> sb.append(p)
                else -> error("unsupported challenge element")
            }
        }
        return sb.append(']').toString()
    }

    fun inviteChallenge(coordinate: String, attendeePubkey: String): ByteArray =
        Bytes.sha256(Bytes.utf8(stringArray(INVITE_PROOF_TAG, coordinate, attendeePubkey)))

    /** sha256(invite pubkey bytes), hex — what kind 31601 publishes. */
    fun inviteHash(invitePubkeyHex: String): String = Bytes.sha256Hex(Bytes.fromHex(invitePubkeyHex))

    data class InviteProof(val invitePubkey: String, val sig: String)

    fun makeInviteProof(inviteSk: ByteArray, coordinate: String, attendeePubkey: String): InviteProof =
        InviteProof(
            invitePubkey = Secp.pubkeyHex(inviteSk),
            sig = Bytes.toHex(Secp.sign(inviteChallenge(coordinate, attendeePubkey), inviteSk)),
        )

    fun verifyInviteProof(proof: InviteProof, coordinate: String, attendeePubkey: String): Boolean {
        if (!proof.invitePubkey.isHex32() || !proof.sig.isHex64()) return false
        return Secp.verify(Bytes.fromHex(proof.sig), inviteChallenge(coordinate, attendeePubkey), Bytes.fromHex(proof.invitePubkey))
    }

    // ── Chat device proof of possession (NIP §10.2) ─────────────────────────

    fun chatDeviceChallenge(coordinate: String, accountPubkey: String, chatPubkey: String, createdAt: Long): ByteArray =
        Bytes.sha256(Bytes.utf8(stringArray(CHAT_DEVICE_PROOF_TAG, coordinate, accountPubkey, chatPubkey, createdAt)))

    fun makeChatDeviceProof(deviceSk: ByteArray, coordinate: String, accountPubkey: String, createdAt: Long): String {
        val chatPubkey = Secp.pubkeyHex(deviceSk)
        return Bytes.toHex(Secp.sign(chatDeviceChallenge(coordinate, accountPubkey, chatPubkey, createdAt), deviceSk))
    }

    fun verifyChatDeviceProof(sig: String, coordinate: String, accountPubkey: String, chatPubkey: String, createdAt: Long): Boolean {
        if (!sig.isHex64() || !chatPubkey.isHex32()) return false
        return Secp.verify(Bytes.fromHex(sig), chatDeviceChallenge(coordinate, accountPubkey, chatPubkey, createdAt), Bytes.fromHex(chatPubkey))
    }
}
