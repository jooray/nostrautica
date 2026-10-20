package today.cypherpunk.nostrautica.protocol

/**
 * Union of two copies of an organizer's 30078 event-keys backup (audit SB-89).
 * Port of packages/protocol/src/keys-backup.ts: ECK versions by (id, key), staged
 * ones kept staged, the higher install generation, and every E_inbox secret kept:
 * the one [configInbox] (a pubkey, from the newest 31600) names is current, else
 * [a]'s; the rest are prior.
 */
object KeysBackup {
    private fun inboxPubkey(secretHex: String): String? = runCatching { Secp.pubkeyHex(Bytes.fromHex(secretHex)) }.getOrNull()

    fun merge(a: EventKeysBackup, b: EventKeysBackup, configInbox: String? = null): EventKeysBackup {
        val eck = EckIdentity.union(a.eck, b.eck)
        val pending = EckIdentity.union(a.pendingEck ?: emptyList(), b.pendingEck ?: emptyList())
            .filter { p -> eck.none { it.id == p.id && it.key == p.key } }
        val inboxes = (listOf(a.einboxNsec, b.einboxNsec) + (a.priorEinboxNsecs ?: emptyList()) + (b.priorEinboxNsecs ?: emptyList())).distinct()
        val current = configInbox?.let { c -> inboxes.firstOrNull { inboxPubkey(it) == c } } ?: a.einboxNsec
        val prior = inboxes.filter { it != current }.takeLast(Limits.MAX_PRIOR_INBOXES)
        return EventKeysBackup(
            a = a.a ?: b.a,
            eidNsec = a.eidNsec,
            einboxNsec = current,
            eck = eck,
            coordinatorGen = maxOf(a.coordinatorGen ?: 0, b.coordinatorGen ?: 0),
            pendingEck = pending.ifEmpty { null },
            priorEinboxNsecs = prior.ifEmpty { null },
            coOrganizers = ((a.coOrganizers ?: emptyList()) + (b.coOrganizers ?: emptyList())).distinct().sorted().take(Limits.MAX_ORGANIZERS).ifEmpty { null },
        )
    }
}
