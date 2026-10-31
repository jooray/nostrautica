package today.cypherpunk.nostrautica.domain.chat

/**
 * MDK's per-group stall and fork signals as they arrive on the runtime event stream
 * (audit R-9), kept until the group moves on or MDK reports it recovered. They feed
 * [ChatEngine.SyncHealth], the "re-syncing" banner; never Rejoin.
 */
class GroupTrouble {
    private val marks = HashMap<String, MutableSet<String>>()

    @Synchronized
    fun mark(groupIdHex: String, what: String) { marks.getOrPut(groupIdHex.lowercase()) { mutableSetOf() } += what }

    @Synchronized
    fun clear(groupIdHex: String, vararg what: String) {
        val set = marks[groupIdHex.lowercase()] ?: return
        set.removeAll(what.toSet())
        if (set.isEmpty()) marks.remove(groupIdHex.lowercase())
    }

    @Synchronized
    fun has(groupIdHex: String, what: String): Boolean = marks[groupIdHex.lowercase()]?.contains(what) == true

    companion object {
        const val STALLED = "stalled"
        const val SUPERSEDED = "superseded"
        const val UNRECOVERABLE = "unrecoverable"

        /**
         * MDK `GroupChangeSuperseded.outcome`: only `reissued` needs no user action;
         * every other outcome means the change did not land (mdk#1734).
         */
        fun supersededNeedsAttention(outcome: String): Boolean = outcome != "reissued"
    }
}
