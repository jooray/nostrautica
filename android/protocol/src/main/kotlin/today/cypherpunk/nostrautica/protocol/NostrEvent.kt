package today.cypherpunk.nostrautica.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

/** An unsigned event template: what a signer is asked to sign. */
data class UnsignedEvent(
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
) {
    val id: String get() = NostrEvent.computeId(pubkey, createdAt, kind, tags, content)

    /** As a rumor (NIP-59): an unsigned event that carries its id. */
    fun toRumorJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("pubkey", pubkey)
        put("created_at", createdAt)
        put("kind", kind)
        put("tags", tagsToJson(tags))
        put("content", content)
    }

    fun signWith(sk: ByteArray): NostrEvent {
        val id = id
        val sig = Bytes.toHex(Secp.sign(Bytes.fromHex(id), sk))
        return NostrEvent(id, pubkey, createdAt, kind, tags, content, sig)
    }
}

/** A signed NIP-01 event. */
@Serializable(with = NostrEventSerializer::class)
data class NostrEvent(
    val id: String,
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
    val sig: String,
) {
    fun tag(name: String): String? = tags.firstOrNull { it.size >= 2 && it[0] == name }?.get(1)

    fun tagValues(name: String): List<String> = tags.filter { it.size >= 2 && it[0] == name }.map { it[1] }

    val d: String? get() = tag("d")

    /** Recompute the id and verify the Schnorr signature. */
    fun verify(): Boolean {
        if (!id.isHex32() || !pubkey.isHex32() || !sig.isHex64()) return false
        if (computeId(pubkey, createdAt, kind, tags, content) != id) return false
        return Secp.verify(Bytes.fromHex(sig), Bytes.fromHex(id), Bytes.fromHex(pubkey))
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("pubkey", pubkey)
        put("created_at", createdAt)
        put("kind", kind)
        put("tags", tagsToJson(tags))
        put("content", content)
        put("sig", sig)
    }

    fun toJsonString(): String = JsJson.stringify(toJson())

    companion object {
        /** NIP-01 id: sha256 of `[0,pubkey,created_at,kind,tags,content]`, serialized as JSON.stringify does. */
        fun computeId(pubkey: String, createdAt: Long, kind: Int, tags: List<List<String>>, content: String): String {
            val sb = StringBuilder()
            sb.append("[0,")
            JsJson.appendQuoted(sb, pubkey)
            sb.append(',').append(createdAt).append(',').append(kind).append(",[")
            tags.forEachIndexed { i, tag ->
                if (i > 0) sb.append(',')
                sb.append('[')
                tag.forEachIndexed { j, v -> if (j > 0) sb.append(','); JsJson.appendQuoted(sb, v) }
                sb.append(']')
            }
            sb.append("],")
            JsJson.appendQuoted(sb, content)
            sb.append(']')
            return Bytes.sha256Hex(Bytes.utf8(sb.toString()))
        }

        /** Parse untrusted JSON; null when any field is missing or mistyped. */
        fun fromJson(e: JsonElement): NostrEvent? = runCatching {
            val o = e as JsonObject
            NostrEvent(
                id = o["id"]!!.jsonPrimitive.content.also { require(o["id"]!!.jsonPrimitive.isString) },
                pubkey = o["pubkey"]!!.jsonPrimitive.content,
                createdAt = o["created_at"]!!.jsonPrimitive.long,
                kind = o["kind"]!!.jsonPrimitive.int,
                tags = o["tags"]!!.jsonArray.map { t -> t.jsonArray.map { s -> s.jsonPrimitive.also { require(it.isString) }.content } },
                content = o["content"]!!.jsonPrimitive.also { require(it.isString) }.content,
                sig = o["sig"]!!.jsonPrimitive.content,
            )
        }.getOrNull()

        fun fromJsonString(s: String): NostrEvent? =
            runCatching { Json.parseToJsonElement(s) }.getOrNull()?.let(::fromJson)
    }
}

fun tagsToJson(tags: List<List<String>>): JsonArray =
    JsonArray(tags.map { t -> JsonArray(t.map { JsonPrimitive(it) }) })

object NostrEventSerializer : kotlinx.serialization.KSerializer<NostrEvent> {
    override val descriptor = JsonElement.serializer().descriptor
    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: NostrEvent) =
        encoder.encodeSerializableValue(JsonElement.serializer(), value.toJson())
    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): NostrEvent =
        NostrEvent.fromJson(decoder.decodeSerializableValue(JsonElement.serializer()))
            ?: throw kotlinx.serialization.SerializationException("malformed nostr event")
}

/** Current unix time in seconds. */
fun nowSec(): Long = System.currentTimeMillis() / 1000
