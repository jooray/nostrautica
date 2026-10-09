package today.cypherpunk.nostrautica.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlin.random.Random

/** An unwrapped, authenticated rumor (giftwrap.ts `Rumor`). */
@kotlinx.serialization.Serializable
data class Rumor(
    val id: String,
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
) {
    fun tag(name: String): String? = tags.firstOrNull { it.size >= 2 && it[0] == name }?.get(1)
}

/**
 * NIP-59 gift wrap (giftwrap.ts and the app's events/giftwrap.ts signerWrap/
 * signerUnwrap): rumor → kind-13 seal signed by the author → kind-1059 wrap signed
 * by a one-time key. Unwrapping enforces everything the TS module does: a verified
 * wrap, a complete signed seal with empty tags, a well-formed rumor of an allowed
 * kind, rumor author == seal author, and a recomputed rumor id.
 */
object GiftWrap {
    const val MAX_BACKDATE_SEC = 2L * 24 * 60 * 60
    const val RUMOR_MAX_CLOCK_SKEW_SEC = 15L * 60

    class UnwrapException(message: String) : Exception(message)

    /** `since` for 1059 subscriptions: two days of jitter plus one day of reach. */
    fun since(now: Long = nowSec()): Long = now - MAX_BACKDATE_SEC - 24 * 60 * 60

    private fun randomPast(now: Long): Long = now - Random.nextLong(MAX_BACKDATE_SEC)

    fun rumor(authorPubkey: String, kind: Int, content: String, tags: List<List<String>> = emptyList(), createdAt: Long = nowSec()): UnsignedEvent {
        require(kind in Kinds.RUMOR_KINDS) { "kind $kind may not be gift-wrapped (NIP §5)" }
        return UnsignedEvent(authorPubkey, createdAt, kind, tags, content)
    }

    /** Seal with the author's signer (one NIP-44 encrypt + one sign), wrap locally. */
    suspend fun wrap(author: NostrSigner, recipientPubkey: String, rumor: UnsignedEvent, now: Long = nowSec()): NostrEvent {
        require(rumor.pubkey == author.pubkey) { "rumor author must be the sealing signer" }
        val sealContent = author.nip44Encrypt(recipientPubkey, JsJson.stringify(rumor.toRumorJson()))
        val seal = author.sign(UnsignedEvent(author.pubkey, randomPast(now), Kinds.SEAL, emptyList(), sealContent))
        return wrapSeal(seal, recipientPubkey, now)
    }

    fun wrapSeal(seal: NostrEvent, recipientPubkey: String, now: Long = nowSec()): NostrEvent {
        val otk = Secp.generateSecret()
        val content = Nip44.encryptTo(otk, recipientPubkey, seal.toJsonString())
        return UnsignedEvent(Secp.pubkeyHex(otk), randomPast(now), Kinds.GIFT_WRAP, listOf(listOf("p", recipientPubkey)), content)
            .signWith(otk)
    }

    /** Unwrap with any signer (local or remote). Two decrypts: wrap→seal, seal→rumor. */
    suspend fun unwrap(wrap: NostrEvent, recipient: NostrSigner, allowedKinds: Set<Int> = Kinds.RUMOR_KINDS): Rumor {
        if (wrap.kind != Kinds.GIFT_WRAP) throw UnwrapException("not a gift wrap (kind ${wrap.kind})")
        if (!Nip44.isCiphertext(wrap.content)) throw UnwrapException("wrap content is not a NIP-44 payload")
        if (!wrap.verify()) throw UnwrapException("gift wrap signature is invalid")
        val sealJson = recipient.nip44Decrypt(wrap.pubkey, wrap.content)
        val seal = verifiedSeal(sealJson)
        if (!Nip44.isCiphertext(seal.content)) throw UnwrapException("seal content is not a NIP-44 payload")
        val rumorJson = recipient.nip44Decrypt(seal.pubkey, seal.content)
        return finalizeRumor(rumorJson, seal.pubkey, allowedKinds)
    }

    fun unwrapLocal(wrap: NostrEvent, recipientSk: ByteArray, allowedKinds: Set<Int> = Kinds.RUMOR_KINDS): Rumor {
        if (wrap.kind != Kinds.GIFT_WRAP) throw UnwrapException("not a gift wrap (kind ${wrap.kind})")
        if (!wrap.verify()) throw UnwrapException("gift wrap signature is invalid")
        val seal = verifiedSeal(Nip44.decryptFrom(recipientSk, wrap.pubkey, wrap.content))
        return finalizeRumor(Nip44.decryptFrom(recipientSk, seal.pubkey, seal.content), seal.pubkey, allowedKinds)
    }

    /** `assertVerifiedSeal`: decrypting proves nothing about the author; the seal's signature does. */
    fun verifiedSeal(json: String): NostrEvent {
        val o = runCatching { Json.parseToJsonElement(json) as JsonObject }.getOrNull()
            ?: throw UnwrapException("seal is not an object")
        if ((o["kind"] as? JsonPrimitive)?.longOrNull != Kinds.SEAL.toLong()) throw UnwrapException("inner event is not a seal")
        val tags = o["tags"] as? JsonArray ?: throw UnwrapException("seal tags missing")
        if (tags.isNotEmpty()) throw UnwrapException("seal tags must be empty (NIP-59)")
        val seal = NostrEvent.fromJson(o) ?: throw UnwrapException("seal is malformed")
        if (!seal.verify()) throw UnwrapException("seal signature is invalid")
        return seal
    }

    fun finalizeRumor(json: String, sealPubkey: String, allowedKinds: Set<Int>, now: Long = nowSec()): Rumor {
        val o = runCatching { Json.parseToJsonElement(json) as JsonObject }.getOrNull()
            ?: throw UnwrapException("rumor is not an object")
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val id = str("id")?.takeIf { it.isHex32() } ?: throw UnwrapException("rumor id is not 64-char lowercase hex")
        val pubkey = str("pubkey")?.takeIf { it.isHex32() } ?: throw UnwrapException("rumor pubkey is not 64-char lowercase hex")
        val kindP = o["kind"] as? JsonPrimitive
        val kind = kindP?.takeIf { !it.isString }?.content?.toIntOrNull()?.takeIf { it >= 0 }
            ?: throw UnwrapException("rumor kind is not a non-negative integer")
        if (kind !in allowedKinds) throw UnwrapException("rumor kind $kind is not accepted on this key")
        val caP = o["created_at"] as? JsonPrimitive
        val createdAt = caP?.takeIf { !it.isString }?.content?.toLongOrNull()?.takeIf { it >= 0 }
            ?: throw UnwrapException("rumor created_at is not a non-negative integer")
        val tags = (o["tags"] as? JsonArray)?.map { t ->
            (t as? JsonArray)?.map { s -> (s as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw UnwrapException("rumor tags are not strings") }
                ?: throw UnwrapException("rumor tags are not arrays")
        } ?: throw UnwrapException("rumor tags are not an array")
        val content = str("content") ?: throw UnwrapException("rumor content is not a string")
        if (pubkey != sealPubkey) throw UnwrapException("rumor/seal author mismatch")
        if (NostrEvent.computeId(pubkey, createdAt, kind, tags, content) != id) {
            throw UnwrapException("rumor id does not match its contents")
        }
        // PROTO-8: a future-dated rumor gains no ordering advantage.
        val clamped = minOf(createdAt, now + RUMOR_MAX_CLOCK_SKEW_SEC)
        return Rumor(id, pubkey, clamped, kind, tags, content)
    }
}
