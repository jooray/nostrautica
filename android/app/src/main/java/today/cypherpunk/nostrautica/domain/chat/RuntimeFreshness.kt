package today.cypherpunk.nostrautica.domain.chat

/**
 * Whether the running MLS runtime's live subscriptions still cover what it holds.
 *
 * MDK registers its kind-445 group subscriptions when the runtime starts, and two
 * things done to a running one leave them short: a group joined mid-run (the
 * coordinator's Welcome accepted while the chat screen is open), and a change to
 * an account's relay lists while it already holds groups (the known MDK bug: a
 * relay-list change breaks the group subscription until the runtime restarts).
 * Either way the group's state is right, the member count is right, and nobody
 * else's messages arrive until the app is force-stopped and reopened, which is
 * exactly the restart this records the need for (manual e2e BUG-4, 2026-10-20).
 *
 * Each cause asks for one restart. Only an explicit, successful accept or rejoin
 * marks a group, and a restart clears every mark, so a restart cannot cause another.
 */
class RuntimeFreshness {
    private val joined = mutableSetOf<String>()
    private var relaysChanged = false

    /** This runtime accepted a Welcome into [groupIdHex]. */
    @Synchronized
    fun joinedGroup(groupIdHex: String) { joined += groupIdHex.lowercase() }

    /** An account's inbox or NIP-65 relays changed while it held at least one group. */
    @Synchronized
    fun relayListsChanged() { relaysChanged = true }

    /**
     * Restart only when something is stale and [holders] is 1: a restart tears down
     * every open timeline, so it must not happen under another screen's feet. A
     * stale runtime with more holders stays stale until the next lone holder asks.
     */
    @Synchronized
    fun shouldRestart(holders: Int): Boolean = holders == 1 && (relaysChanged || joined.isNotEmpty())

    /** A fresh runtime registered every group it holds. */
    @Synchronized
    fun restarted() {
        joined.clear()
        relaysChanged = false
    }
}
