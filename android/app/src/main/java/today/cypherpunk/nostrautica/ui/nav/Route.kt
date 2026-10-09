package today.cypherpunk.nostrautica.ui.nav

import android.net.Uri
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The PWA's routes (packages/app/src/lib/router/routes.ts), one for one, so any
 * link the web app produces — `#/e/<naddr>/join?code=…&lang=…` in an invite, a
 * pasted event URL — opens the same screen here.
 */
sealed interface Route {
    data object Home : Route
    data class Login(val nsec: String? = null) : Route
    data object Create : Route
    data object Me : Route
    data object Settings : Route
    data object Dm : Route
    data class DmPeer(val npub: String) : Route
    data class NotFound(val hash: String) : Route

    sealed interface InEvent : Route { val naddr: String }
    data class Event(override val naddr: String) : InEvent
    data class Join(override val naddr: String, val code: String? = null) : InEvent
    data class Record(override val naddr: String, val talk: Boolean = false, val editTalk: String? = null) : InEvent
    data class Attendees(override val naddr: String) : InEvent
    data class Attendee(override val naddr: String, val npub: String) : InEvent
    data class Report(override val naddr: String) : InEvent
    data class Chat(override val naddr: String) : InEvent
    data class Talks(override val naddr: String) : InEvent
    data class Talk(override val naddr: String, val d: String) : InEvent
    data class MyProfile(override val naddr: String) : InEvent
    data class Admin(override val naddr: String) : InEvent
    data class EventSettings(override val naddr: String) : InEvent
    data class Posts(override val naddr: String) : InEvent
    data class Post(override val naddr: String, val d: String) : InEvent
    data class EventMore(override val naddr: String) : InEvent

    companion object {
        /** routes.ts parseHash, plus the invite link's `lang=` returned alongside. */
        fun parseHash(hash: String): Pair<Route, String?> {
            var body = hash.removePrefix("#").removePrefix("/")
            val q = body.indexOf('?')
            val path = if (q >= 0) body.substring(0, q) else body
            val query = if (q >= 0) Uri.parse("x://x?" + body.substring(q + 1)) else null
            fun param(name: String) = query?.getQueryParameter(name)?.takeIf { it.isNotEmpty() }
            val lang = param("lang")
            val s = path.split('/').filter { it.isNotEmpty() }
            val route: Route = when {
                s.isEmpty() -> Home
                s[0] == "login" -> Login(param("nsec"))
                s[0] == "create" -> Create
                s[0] == "me" -> Me
                s[0] == "settings" -> Settings
                s[0] == "dm" -> s.getOrNull(1)?.let { DmPeer(it) } ?: Dm
                s[0] == "e" -> {
                    val naddr = s.getOrNull(1)
                    if (naddr == null) NotFound(hash) else when (s.getOrNull(2)) {
                        null -> Event(naddr)
                        "join" -> Join(naddr, param("code"))
                        "record" -> Record(naddr, param("talk") == "1")
                        "matches", "attendees" -> s.getOrNull(3)?.let { Attendee(naddr, it) } ?: Attendees(naddr)
                        "report" -> Report(naddr)
                        "chat" -> Chat(naddr)
                        "talks" -> s.getOrNull(3)?.let { Talk(naddr, it) } ?: Talks(naddr)
                        "profile" -> MyProfile(naddr)
                        "more" -> EventMore(naddr)
                        "admin" -> Admin(naddr)
                        "settings" -> EventSettings(naddr)
                        "posts" -> s.getOrNull(3)?.let { Post(naddr, it) } ?: Posts(naddr)
                        else -> NotFound(hash)
                    }
                }
                else -> NotFound(hash)
            }
            return route to lang
        }

        /**
         * A link that opened the app: https://…/app/#/e/…, a bare naddr, or a
         * nostr:naddr URI.
         */
        fun fromUri(uri: Uri): Pair<Route, String?>? {
            val s = uri.toString()
            return when {
                uri.scheme == "nostr" || s.startsWith("naddr1") -> {
                    val naddr = s.removePrefix("nostr:")
                    if (naddr.startsWith("naddr1")) Event(naddr) to null else null
                }
                uri.fragment != null -> parseHash(uri.fragment!!)
                uri.scheme == "nostrautica" -> parseHash(s.substringAfter("nostrautica://"))
                else -> null
            }
        }

        fun buildHash(r: Route): String = when (r) {
            Home -> "#/"
            is Login -> "#/login"
            Create -> "#/create"
            Me -> "#/me"
            Settings -> "#/settings"
            Dm -> "#/dm"
            is DmPeer -> "#/dm/${r.npub}"
            is NotFound -> r.hash
            is Event -> "#/e/${r.naddr}"
            is Join -> if (r.code != null) "#/e/${r.naddr}/join?code=${r.code}" else "#/e/${r.naddr}/join"
            is Record -> if (r.talk) "#/e/${r.naddr}/record?talk=1" else "#/e/${r.naddr}/record"
            is Attendees -> "#/e/${r.naddr}/attendees"
            is Attendee -> "#/e/${r.naddr}/attendees/${r.npub}"
            is Report -> "#/e/${r.naddr}/report"
            is Chat -> "#/e/${r.naddr}/chat"
            is Talks -> "#/e/${r.naddr}/talks"
            is Talk -> "#/e/${r.naddr}/talks/${r.d}"
            is MyProfile -> "#/e/${r.naddr}/profile"
            is Admin -> "#/e/${r.naddr}/admin"
            is EventSettings -> "#/e/${r.naddr}/settings"
            is Posts -> "#/e/${r.naddr}/posts"
            is Post -> "#/e/${r.naddr}/posts/${r.d}"
            is EventMore -> "#/e/${r.naddr}/more"
        }

        const val WEB_APP = "https://nostrautica.cypherpunk.today/app/"

        /** The web URL of a route, for sharing (a recipient without the app still lands right). */
        fun webUrl(r: Route): String = WEB_APP + buildHash(r)
    }
}

/**
 * A tiny back stack. Compose Navigation would work too, but routes here ARE the
 * PWA's URL grammar, so the stack holds those values directly and deep links need
 * no translation table.
 */
@Stable
class Router(start: Route = Route.Home) {
    var stack by mutableStateOf(listOf(start))
        private set

    val current: Route get() = stack.last()

    fun go(r: Route) {
        if (r == current) return
        stack = stack + r
    }

    /** Switch tabs inside an event without growing the stack per tap. */
    fun switchTo(r: Route) {
        val idx = stack.indexOfLast { it::class == r::class && (it as? Route.InEvent)?.naddr == (r as? Route.InEvent)?.naddr }
        stack = if (idx >= 0) stack.take(idx) + r else {
            val base = stack.indexOfLast { it is Route.Event && (it as Route.Event).naddr == (r as? Route.InEvent)?.naddr }
            if (base >= 0 && r !is Route.Event) stack.take(base + 1) + r else stack + r
        }
    }

    fun replace(r: Route) {
        stack = stack.dropLast(1) + r
    }

    fun resetTo(r: Route) {
        stack = listOf(r)
    }

    fun back(): Boolean {
        if (stack.size <= 1) return false
        stack = stack.dropLast(1)
        return true
    }
}
