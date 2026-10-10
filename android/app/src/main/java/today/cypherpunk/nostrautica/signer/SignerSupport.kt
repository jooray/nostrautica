package today.cypherpunk.nostrautica.signer

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * Work the user didn't start (a badge refresh, a background scan) must never pop
 * up a signer. Run it inside [silently]: a remote signer then answers only when it
 * can do so without UI (Amber's content provider with a remembered permission),
 * and otherwise throws [SignerNeedsUser] — the PWA's "remote signers stay
 * ciphertext-only until asked" rule.
 */
class Silent : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<Silent>
}

suspend fun <T> silently(block: suspend () -> T): T = withContext(Silent()) { block() }

suspend fun isSilent(): Boolean = currentCoroutineContext()[Silent] != null

class SignerNeedsUser : Exception("the signer needs the user to approve this")

class SignerRejected(message: String = "the signer declined") : Exception(message)

class SignerUnavailable(message: String) : Exception(message)

/** What the app asks a remote signer for up front (signer/nip46.ts DEFAULT_PERMS). */
object SignerPermissions {
    val SIGN_KINDS = listOf(0, 3, 5, 13, 10000, 10050, 10002, 24242, 30078, 31600, 31601, 31602, 31923, 31925)

    val NIP46: String = (SIGN_KINDS.map { "sign_event:$it" } + listOf("nip44_encrypt", "nip44_decrypt")).joinToString(",")

    val NIP55_JSON: String = buildString {
        append('[')
        SIGN_KINDS.forEach { append("""{"type":"sign_event","kind":$it},""") }
        append("""{"type":"nip44_encrypt"},{"type":"nip44_decrypt"}""")
        append(']')
    }
}
