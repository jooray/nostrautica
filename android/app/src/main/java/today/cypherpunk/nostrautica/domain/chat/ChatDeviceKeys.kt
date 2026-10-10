package today.cypherpunk.nostrautica.domain.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.Secp

/** The slice of SecureStore this needs, so the logic runs in JVM tests. */
interface SecretKv {
    fun get(name: String): String?
    fun put(name: String, value: String?)
}

/**
 * This phone's chat DEVICE identity per account (chat/identity.ts): a fresh
 * secp256k1 key minted on first chat use, for every account type, never the
 * account key, never backed up or restored. Plus the per-device bits that ride
 * with it: the `client_id` slot name, the label the user chose, the union of chat
 * relays this device advertises, and a pending White Noise link.
 *
 * All of it lives in the Keystore-sealed SecureStore. Minting is serialized, so
 * two events opening chat at once can never fork the device identity.
 */
class ChatDeviceKeys(private val kv: SecretKv) {
    data class Device(val account: String, val secret: ByteArray, val pubkey: String, val clientId: String) {
        val secretHex: String get() = Bytes.toHex(secret)
    }

    @Serializable
    data class PendingLink(val chatPubkey: String, val startedAt: Long)

    private val json = Json { ignoreUnknownKeys = true }

    @Synchronized
    fun ensure(account: String): Device {
        val sk = kv.get(keyName(account))?.takeIf { it.length == 64 }?.let(Bytes::fromHex)?.takeIf(Secp::isValidSecret)
            ?: Secp.generateSecret().also { kv.put(keyName(account), Bytes.toHex(it)) }
        val pk = Secp.pubkeyHex(sk)
        val clientId = kv.get(clientName(pk)) ?: ("android-" + Bytes.toHex(Bytes.random(8))).also { kv.put(clientName(pk), it) }
        return Device(account, sk, pk, clientId)
    }

    /** The stored device key, or null — never mints. */
    @Synchronized
    fun peek(account: String): Device? {
        val sk = kv.get(keyName(account))?.takeIf { it.length == 64 }?.let(Bytes::fromHex)?.takeIf(Secp::isValidSecret) ?: return null
        return ensure(account)
    }

    /** Store a device key minted elsewhere (the chat engine) as this account's. */
    @Synchronized
    fun adopt(account: String, sk: ByteArray): Device {
        require(Secp.isValidSecret(sk)) { "invalid device key" }
        kv.put(keyName(account), Bytes.toHex(sk))
        return ensure(account)
    }

    /** Forget a device key that never made it into the engine. */
    @Synchronized
    fun discard(account: String) = kv.put(keyName(account), null)

    /** The device key without minting one (the device list's "this device" badge). */
    fun peekPubkey(account: String): String? =
        kv.get(keyName(account))?.takeIf { it.length == 64 }?.let { runCatching { Secp.pubkeyHex(Bytes.fromHex(it)) }.getOrNull() }

    fun label(chatPubkey: String): String? = kv.get(labelName(chatPubkey))?.trim()?.takeIf { it.isNotEmpty() }

    fun saveLabel(chatPubkey: String, label: String) {
        label.trim().takeIf { it.isNotEmpty() }?.let { kv.put(labelName(chatPubkey), it) }
    }

    /** The chat relays this device key advertises (10050/10002): a union across events. */
    fun advertisedRelays(chatPubkey: String): List<String> =
        kv.get(relaysName(chatPubkey))?.let { runCatching { json.decodeFromString(ListSerializer(String.serializer()), it) }.getOrNull() } ?: emptyList()

    fun saveAdvertisedRelays(chatPubkey: String, relays: List<String>) =
        kv.put(relaysName(chatPubkey), json.encodeToString(ListSerializer(String.serializer()), relays))

    fun pendingLink(account: String, coordinate: String, nowMs: Long = System.currentTimeMillis()): PendingLink? {
        val p = kv.get(linkName(account, coordinate))?.let { runCatching { json.decodeFromString(PendingLink.serializer(), it) }.getOrNull() } ?: return null
        if (!Regex("^[0-9a-f]{64}$").matches(p.chatPubkey)) return null
        if (nowMs - p.startedAt * 1000 > ExternalLink.PENDING_TTL_MS) return null
        return p
    }

    fun savePendingLink(account: String, coordinate: String, link: PendingLink?) =
        kv.put(linkName(account, coordinate), link?.let { json.encodeToString(PendingLink.serializer(), it) })

    companion object {
        private fun keyName(account: String) = "chat.device:$account"
        private fun clientName(pk: String) = "chat.client:$pk"
        private fun labelName(pk: String) = "chat.label:$pk"
        private fun relaysName(pk: String) = "chat.relays:$pk"
        private fun linkName(account: String, coordinate: String) = "chat.link:$account:$coordinate"

        /** At most this many advertised chat relays; the newest event's set always fits. */
        const val MAX_ADVERTISED_RELAYS = 20

        /** Union [current] (first, so it is never dropped) with [previous], capped. */
        fun mergeRelays(previous: List<String>, current: List<String>): List<String> =
            (current + previous).distinct().take(MAX_ADVERTISED_RELAYS)
    }
}
