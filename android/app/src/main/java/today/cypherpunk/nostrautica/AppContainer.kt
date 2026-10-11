package today.cypherpunk.nostrautica

import android.content.Context
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.data.EventStore
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.domain.Accounts
import today.cypherpunk.nostrautica.domain.Communities
import today.cypherpunk.nostrautica.domain.CommunityStore
import today.cypherpunk.nostrautica.domain.EventContexts
import today.cypherpunk.nostrautica.domain.Grants
import today.cypherpunk.nostrautica.domain.Members
import today.cypherpunk.nostrautica.domain.Membership
import today.cypherpunk.nostrautica.domain.Profiles
import today.cypherpunk.nostrautica.domain.Social
import today.cypherpunk.nostrautica.domain.EventKeysStore
import today.cypherpunk.nostrautica.i18n.I18n
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.nostr.RelayPool
import today.cypherpunk.nostrautica.signer.SecureStore
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.signer.SignerIntentBridge

/** Manual dependency wiring: one instance of each service for the process. */
class AppContainer(val context: Context) {
    val i18n = I18n(context)
    val http = RelayPool.newHttpClient()
    val db = AppDatabase.open(context)
    val store = EventStore(db)
    val cache = Cache(db)
    val pool = RelayPool(http)
    val nostr = Nostr(context, pool, store, db)
    val secure = SecureStore(context)
    val bridge = SignerIntentBridge()
    val session = Session(context, secure, pool, bridge)
    val eventKeys = EventKeysStore(secure)
    val contexts = EventContexts(nostr, cache)
    val prefs = AppPrefs(context)
    val accounts = Accounts(session, nostr, cache)
    val members = Members(nostr, cache, eventKeys)
    val profiles = Profiles(nostr, cache)
    val membership = Membership(nostr, cache, eventKeys, prefs)
    val communityStore = CommunityStore(cache)
    val grants = Grants(nostr, cache, eventKeys, contexts, accounts, prefs, communityStore)
    /** Space hierarchy (§15): link reads, the attendee's offer and the consent-gated community join. */
    val communities: Communities by lazy { Communities(this) }
    val social = Social(nostr, accounts)

    init {
        // After every grant scan, stored community proofs are re-evaluated (§15.5).
        grants.afterScan = { signer, children, interactive -> communities.autoJoin(signer, children, interactive) }
    }

    private val areas = java.util.concurrent.ConcurrentHashMap<String, Any>()

    /**
     * Feature areas register their services lazily, from their own files:
     * `val AppContainer.dms: Dms get() = area("dms") { Dms(nostr, accounts) }`.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T : Any> area(key: String, create: () -> T): T =
        (areas[key] ?: synchronized(areas) { areas.getOrPut(key, create) }) as T
}
