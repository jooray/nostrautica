package today.cypherpunk.nostrautica.domain.chat

/**
 * Whether the running MLS runtime's live subscriptions may no longer cover what it
 * holds, so a restart (close and reopen, what a force-stop did) is worth its cost.
 *
 * Two causes are recorded: a change to an account's relay lists while it already
 * holds groups (the known MDK bug: a relay-list change breaks the group
 * subscription until the runtime restarts), and a confirmed rejoin of a group the
 * store already held.
 *
 * A group joined mid-run is NOT a cause. MarmotKit 0.13.0 installs the joined
 * group's kind-445 subscription itself, about a second after the Welcome; the
 * relay log of the 2026-10-20 freeze investigation shows the `marmot:group` REQ on
 * the running runtime's socket every time, and the three test messages arrived
 * live with no restart. Restarting for it only cost a window with no live
 * subscription at all (3-5 s on an idle emulator, 30+ s on a starved one, while
 * MDK closed its databases and reopened them).
 *
 * Each cause asks for one restart, and a restart clears every mark, so a restart
 * cannot cause another.
 */
class RuntimeFreshness {
    private val rejoinedGroups = mutableSetOf<String>()
    private var relaysChanged = false

    /** This runtime confirmed a rejoin into [groupIdHex]. */
    @Synchronized
    fun rejoined(groupIdHex: String) { rejoinedGroups += groupIdHex.lowercase() }

    /** An account's inbox or NIP-65 relays changed while it held at least one group. */
    @Synchronized
    fun relayListsChanged() { relaysChanged = true }

    /**
     * Restart only when something is stale and [holders] is 1: a restart tears down
     * every open timeline, so it must not happen under another screen's feet. A
     * stale runtime with more holders stays stale until the next lone holder asks.
     */
    @Synchronized
    fun shouldRestart(holders: Int): Boolean = holders == 1 && (relaysChanged || rejoinedGroups.isNotEmpty())

    /** Why [shouldRestart] is true, for the log. */
    @Synchronized
    fun reason(): String = listOfNotNull(
        "relay lists changed".takeIf { relaysChanged },
        "rejoined a group".takeIf { rejoinedGroups.isNotEmpty() },
    ).joinToString(" and ")

    /** A fresh runtime registered every group it holds. */
    @Synchronized
    fun restarted() {
        rejoinedGroups.clear()
        relaysChanged = false
    }
}
