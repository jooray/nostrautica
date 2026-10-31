package today.cypherpunk.nostrautica.domain.chat

import kotlinx.coroutines.flow.Flow

/** One rendered chat line (a kind-9 with MDK's effective content, reactions and edit state). */
data class ChatMessage(
    val id: String,
    /** The sender's chat DEVICE key (hex). */
    val sender: String,
    val text: String,
    val at: Long,
    val edited: Boolean = false,
    val deleted: Boolean = false,
    val reactions: List<Reaction> = emptyList(),
    /** A durable local send MDK has accepted but not yet confirmed on a relay. */
    val pending: Boolean = false,
) {
    data class Reaction(val emoji: String, val count: Int, val mine: Boolean)
}

/** The chat runtime did not get through a step in time: an ordinary, retryable failure. */
class ChatEngineTimeout(message: String) : Exception(message)

/** A bounded timeline window as MDK materializes it. */
data class ChatPage(val messages: List<ChatMessage>, val hasMoreBefore: Boolean)

/**
 * The MLS engine boundary. The production implementation is MarmotKit
 * ([MarmotEngine]); everything the session decides on top of it (routing, phase,
 * what to publish when) stays testable without the 46 MB native library, which
 * cannot load in a JVM unit test.
 */
interface ChatEngine {
    /** Hold the runtime open (starting it if needed). Pair every call with [release]. */
    suspend fun acquire()

    /** Drop a hold; the runtime closes after a short grace period with no holder. */
    fun release()

    /**
     * Restart the runtime when its live group subscriptions may be missing a group
     * joined mid-run or a changed relay list ([RuntimeFreshness]), and only while the
     * caller is its sole holder. Returns whether it restarted; every timeline handle
     * from before is then dead and must be opened again.
     */
    suspend fun refreshIfStale(): Boolean

    /**
     * Make [device] a local-signing account (importing its key the first time) that
     * advertises [relays] as its 10002/10050. Returns the account reference.
     */
    suspend fun ensureAccount(device: ChatDeviceKeys.Device, relays: List<String>, bootstrap: List<String>): String

    /**
     * Mint a brand-new device identity inside the engine and return its secret.
     * Unlike importing a key (which first runs a relay-list discovery that must
     * be conclusive on every discovery relay, and a fresh key has nothing to
     * discover), this publishes the new account's relay lists directly.
     */
    suspend fun createDeviceIdentity(relays: List<String>, bootstrap: List<String>): ByteArray

    /** Whether the engine already holds an account for this device key. */
    suspend fun hasAccount(pubkey: String): Boolean

    /** The initial key package and relay lists have been published (MDK NETWORK_READY). */
    suspend fun networkReady(account: String): Boolean

    /** Every local group, or a throw: never a silently partial list (audit K-4). */
    suspend fun groups(account: String): List<GroupBinding.GroupInfo>

    /** Accept a pending invitation. Returns false when MDK refused or failed it. */
    suspend fun acceptInvite(account: String, groupIdHex: String): Boolean

    /**
     * Confirm a pending rejoin offer (a re-add Welcome into a group we hold stale
     * state for) when it was sealed by [coordinator]. Returns whether one was confirmed.
     */
    suspend fun confirmRejoin(account: String, groupIdHex: String, coordinator: String): Boolean

    /** Publish a fresh key package in this device's slot (new event id, new init key). */
    suspend fun rotateKeyPackage(account: String)

    /** Re-publish the current key package (or a fresh one when none is cached). */
    suspend fun republishKeyPackage(account: String)

    /**
     * Send a kind-9. Returns false when MDK only queued it durably. Mentions need
     * nothing extra: MDK's chat builder (`mention_p_tags`) adds one `["p", hex]`
     * per `@npub1…` in [text], as for White Noise ([Mentions]).
     */
    suspend fun sendText(account: String, groupIdHex: String, text: String): Boolean

    suspend fun react(account: String, groupIdHex: String, messageId: String, emoji: String)

    suspend fun unreact(account: String, groupIdHex: String, messageId: String)

    /**
     * Replace the text of one of our own kind-9s (MDK `editMessage`: a kind 1009
     * whose tags MDK builds, `["e", messageId]` plus one `["p", hex]` per mention
     * in [content]).
     */
    suspend fun edit(account: String, groupIdHex: String, messageId: String, content: String)

    /** Delete one of our own kind-9s for everyone (MDK `deleteMessage`: a kind 5, `[["e", messageId]]`). */
    suspend fun delete(account: String, groupIdHex: String, messageId: String)

    /** Live timeline windows for one group, newest last. */
    fun timeline(account: String, groupIdHex: String, me: String): TimelineHandle

    /**
     * Whether this device's copy of [groupIdHex] is out of step with the room (audit
     * R-9). [unrecoverable] is the group record's own flag, already read by [groups].
     */
    suspend fun syncHealth(account: String, groupIdHex: String, unrecoverable: Boolean): SyncHealth

    /**
     * MDK's fork and stall signals for one group. Every one of them means "re-syncing,
     * some history may be missing", and none is evidence of being out of the room:
     * MDK documents `automaticRecoveryFailed` as "not membership evidence", and a
     * Rejoin (remove + add) would only add a kick to the stall.
     */
    data class SyncHealth(
        /** MDK `EpochStallEscalated`: armed backfills did not catch the group up. */
        val stalled: Boolean = false,
        /** MDK `GroupChangeSuperseded` with an outcome other than `reissued`. */
        val superseded: Boolean = false,
        /** The local copy is frozen pending verified repair. */
        val unrecoverable: Boolean = false,
        /** `GroupRecoveryStatus.automaticRecoveryFailed`. */
        val automaticRecoveryFailed: Boolean = false,
        /** `GroupRecoveryStatus.historyMayBeIncomplete`. */
        val historyMayBeIncomplete: Boolean = false,
    ) {
        val resyncing: Boolean get() = stalled || superseded || unrecoverable || automaticRecoveryFailed || historyMayBeIncomplete
    }

    /** What MDK reported for [account], reduced to what the session reacts to. */
    fun changes(account: String): Flow<Change>

    /** One MDK runtime event. [groupIdHex] is null for an account-wide one. */
    data class Change(val groupIdHex: String?, val kind: ChangeKind)

    enum class ChangeKind {
        /** Membership, epoch, invitation or other group state. */
        STATE,
        /** An application message (the open timeline renders it by itself). */
        MESSAGE,
        /** Sync health: a stalled epoch, a superseded change, history that may be incomplete. */
        HEALTH,
    }

    interface TimelineHandle {
        val pages: Flow<ChatPage>
        suspend fun older(count: Int): ChatPage?
        fun close()
    }
}
