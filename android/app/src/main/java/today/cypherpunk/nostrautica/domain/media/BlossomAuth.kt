package today.cypherpunk.nostrautica.domain.media

import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.NostrEvent
import today.cypherpunk.nostrautica.protocol.NostrSigner
import today.cypherpunk.nostrautica.protocol.UnsignedEvent
import today.cypherpunk.nostrautica.protocol.nowSec

/**
 * Blossom authorization (blossom/auth.ts, BUD-01/02/04): a kind-24242 event signed
 * by the user, sent as `Authorization: Nostr <base64(json)>`, with `t` (verb),
 * `x` (sha256 of the blob) and `expiration` tags.
 */
object BlossomAuth {
    enum class Verb(val wire: String) { UPLOAD("upload"), GET("get"), LIST("list"), DELETE("delete") }

    /** The unsigned template; split out so its exact shape is testable without a signer. */
    fun template(
        pubkey: String,
        verb: Verb,
        sha256: String? = null,
        now: Long = nowSec(),
        expirationSec: Long? = null,
        description: String = "",
    ): UnsignedEvent {
        val tags = mutableListOf(listOf("t", verb.wire))
        if (sha256 != null) tags += listOf("x", sha256)
        tags += listOf("expiration", (expirationSec ?: (now + 3600)).toString())
        return UnsignedEvent(pubkey, now, Kinds.BLOSSOM_AUTH, tags, description)
    }

    suspend fun build(signer: NostrSigner, verb: Verb, sha256: String? = null): NostrEvent =
        signer.sign(template(signer.pubkey, verb, sha256))

    /** `Nostr base64(JSON.stringify(event))`. */
    fun header(event: NostrEvent): String = "Nostr " + Bytes.toBase64(Bytes.utf8(event.toJsonString()))
}
