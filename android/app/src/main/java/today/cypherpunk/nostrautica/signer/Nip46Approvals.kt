package today.cypherpunk.nostrautica.signer

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * NIP-46 `auth_url` challenges waiting on the user (nip46.ts onNip46AuthUrl).
 *
 * A bunker that wants approval in a browser answers a request with
 * `result: "auth_url"` and the URL in `error`, then sends the real reply on the
 * same id once the user approves. Nothing showed that URL before, so such a
 * bunker could never be approved and sign-in timed out with "the signer did not
 * answer" (audit R-77). Process-wide on purpose: the challenge can arrive on a
 * login probe or on any later sign/encrypt call, long after the login screen is
 * gone, and AppRoot shows it over whichever screen is up. Each entry is cleared
 * when its request settles (reply, timeout or failure), so the link never
 * outlives the call it approves.
 */
object Nip46Approvals {
    private val byRequest = LinkedHashMap<String, String>()
    private val _url = MutableStateFlow<String?>(null)
    /** The newest approval link still waiting, or null. */
    val url: StateFlow<String?> get() = _url

    @Synchronized fun open(requestId: String, url: String) {
        byRequest[requestId] = url
        _url.value = url
    }

    @Synchronized fun isOpen(requestId: String): Boolean = byRequest.containsKey(requestId)

    @Synchronized fun settle(requestId: String) {
        if (byRequest.remove(requestId) != null) _url.value = byRequest.values.lastOrNull()
    }

    /** The user closed the banner. The calls keep waiting for their replies. */
    @Synchronized fun dismiss() {
        byRequest.clear()
        _url.value = null
    }

    /**
     * Only an https link with a host and no userinfo reaches the UI (nip46.ts
     * safeNip46AuthUrl). The URL comes from the bunker, so `intent:`, `file:`,
     * `javascript:` or a `https://bank@evil` lookalike must never become a button.
     */
    fun safeAuthUrl(value: String): String? {
        val uri = runCatching { java.net.URI(value.trim()) }.getOrNull() ?: return null
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        if (uri.rawUserInfo != null || uri.host.isNullOrEmpty()) return null
        return uri.toString()
    }
}
