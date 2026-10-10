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

    suspend fun groups(account: String): List<GroupBinding.GroupInfo>

    suspend fun acceptInvite(account: String, groupIdHex: String)

    /**
     * Confirm a pending rejoin offer (a re-add Welcome into a group we hold stale
     * state for) when it was sealed by [coordinator]. Returns whether one was confirmed.
     */
    suspend fun confirmRejoin(account: String, groupIdHex: String, coordinator: String): Boolean

    /** Publish a fresh key package in this device's slot (new event id, new init key). */
    suspend fun rotateKeyPackage(account: String)

    /** Re-publish the current key package (or a fresh one when none is cached). */
    suspend fun republishKeyPackage(account: String)

    /** Send a kind-9. Returns false when MDK only queued it durably. */
    suspend fun sendText(account: String, groupIdHex: String, text: String): Boolean

    suspend fun react(account: String, groupIdHex: String, messageId: String, emoji: String)

    suspend fun unreact(account: String, groupIdHex: String, messageId: String)

    /** Live timeline windows for one group, newest last. */
    fun timeline(account: String, groupIdHex: String, me: String): TimelineHandle

    /** Fires whenever MDK reports a group/state change for [account]. */
    fun changes(account: String): Flow<Unit>

    interface TimelineHandle {
        val pages: Flow<ChatPage>
        suspend fun older(count: Int): ChatPage?
        fun close()
    }
}
