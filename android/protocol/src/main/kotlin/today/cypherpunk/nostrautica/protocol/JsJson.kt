package today.cypherpunk.nostrautica.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Serialization that is byte-identical to JavaScript's `JSON.stringify`.
 *
 * Several things on the wire are hashes of a JSON string a TypeScript peer built:
 * event ids (NIP-01 serialization), the invite proof challenge and the chat-device
 * proof challenge. kotlinx.serialization escapes some characters differently, so
 * anything that is hashed goes through here instead.
 */
object JsJson {
    fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2)
        appendQuoted(sb, s)
        return sb.toString()
    }

    fun appendQuoted(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c == '\b' -> sb.append("\\b")
                c == '\u000c' -> sb.append("\\f")
                c < ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
                // ES2019 well-formed JSON.stringify: lone surrogates are escaped.
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) {
                        sb.append(c).append(s[i + 1])
                        i++
                    } else {
                        sb.append("\\u").append(String.format("%04x", c.code))
                    }
                }
                Character.isLowSurrogate(c) -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    /** `JSON.stringify` of a kotlinx JSON tree (object keys in their stored order). */
    fun stringify(element: JsonElement): String = StringBuilder().also { write(it, element) }.toString()

    private fun write(sb: StringBuilder, e: JsonElement) {
        when (e) {
            is JsonNull -> sb.append("null")
            is JsonPrimitive -> when {
                e.isString -> appendQuoted(sb, e.content)
                e.booleanOrNull != null -> sb.append(e.content)
                e.longOrNull != null -> sb.append(e.longOrNull)
                else -> sb.append(formatNumber(e.doubleOrNull ?: error("not a number: ${e.content}")))
            }
            is JsonArray -> {
                sb.append('[')
                e.forEachIndexed { i, item -> if (i > 0) sb.append(','); write(sb, item) }
                sb.append(']')
            }
            is JsonObject -> {
                sb.append('{')
                var first = true
                for ((k, v) in e) {
                    if (!first) sb.append(',')
                    first = false
                    appendQuoted(sb, k)
                    sb.append(':')
                    write(sb, v)
                }
                sb.append('}')
            }
        }
    }

    private fun formatNumber(d: Double): String {
        require(d.isFinite()) { "JSON cannot carry $d" }
        if (d == Math.floor(d) && kotlin.math.abs(d) < 1e21) return d.toLong().toString()
        return d.toString()
    }
}
