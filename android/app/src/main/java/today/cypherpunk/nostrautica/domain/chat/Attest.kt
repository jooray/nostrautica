package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.protocol.ChatKeyAttestationContent
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Wire

/**
 * Chat device attestation (kind 21607, NIP §10.2; chat/attest.ts).
 *
 * Every device mints its own chat key (all account types) and binds it to the
 * account with a 21607 rumor gift-wrapped to the event coordinator and sealed by
 * the ACCOUNT's signer. `op:"add"` carries a proof of possession: a BIP-340
 * signature by the device key over the §10.2 challenge, which binds the rumor's
 * `created_at`, so the rumor must be built with exactly the timestamp the proof
 * signed. `revoke`, `link` and `link_confirm` carry no proof.
 *
 * Pure: building and validating the payload is unit-tested; sending it
 * ([Chat.attest]) is the only impure step.
 */
object ChatAttest {
    enum class Op(val wire: String) { ADD("add"), REVOKE("revoke"), LINK("link"), LINK_CONFIRM("link_confirm") }

    /** Build and validate the 21607 content. Throws on a payload the coordinator would refuse. */
    fun content(
        coordinate: String,
        accountPubkey: String,
        op: Op,
        chatPubkey: String,
        createdAt: Long,
        label: String? = null,
        clientId: String? = null,
        deviceSecret: ByteArray? = null,
        code: String? = null,
    ): ChatKeyAttestationContent {
        val proof = if (op == Op.ADD) {
            val sk = requireNotNull(deviceSecret) { "an add needs the device secret for its proof of possession" }
            ProtocolCrypto.makeChatDeviceProof(sk, coordinate, accountPubkey, createdAt)
        } else null
        return ChatKeyAttestationContent(
            a = coordinate,
            op = op.wire,
            chatPubkey = chatPubkey,
            label = label?.trim()?.takeIf { it.isNotEmpty() }?.take(MAX_LABEL),
            clientId = clientId,
            proof = proof,
            code = code,
        ).also { it.validate() }
    }

    fun json(c: ChatKeyAttestationContent): String = Wire.json.encodeToString(ChatKeyAttestationContent.serializer(), c)

    private const val MAX_LABEL = 60
}
