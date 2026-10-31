package today.cypherpunk.nostrautica.domain.chat

import today.cypherpunk.nostrautica.protocol.Bytes

/**
 * When the device key's kind-0 is worth publishing again (audit S-2): only when its
 * content or the relay set it goes to changed, or [REPUBLISH_SEC] went by (a relay
 * may have dropped it). The stamp is `<hash> <created_at>`.
 */
object DeviceProfileStamp {
    const val REPUBLISH_SEC = 7 * 24 * 3600L

    fun hash(content: String, relays: List<String>): String =
        Bytes.sha256Hex((content + "\n" + relays.distinct().sorted().joinToString("\n")).toByteArray())

    fun stamp(hash: String, atSec: Long): String = "$hash $atSec"

    fun due(stored: String?, hash: String, nowSec: Long): Boolean {
        val parts = stored?.split(" ") ?: return true
        val at = parts.getOrNull(1)?.toLongOrNull() ?: return true
        return parts[0] != hash || nowSec - at >= REPUBLISH_SEC || at > nowSec + 600
    }
}
