package today.cypherpunk.nostrautica.protocol

/**
 * Space hierarchy (PROTOCOL-NIP.md §15, packages/protocol/src/hierarchy.ts): a
 * community (31612) and the events (31923) that belong to it. Membership flows up
 * only: a membership proof signed by an authority of the child event (its E_id or
 * its current coordinator) lets an approved attendee join the parent community.
 * The link is two-sided: the child names its parent, the parent lists the child.
 */
object Hierarchy {
    const val MAX_CHILDREN = 500
    const val PARENT_TAG = "parent"
    const val CHILD_TAG = "child"
    const val MEMBER_OF_TAG = "member_of"
    private const val PROOF_TAG = "nostrautica-member-of-v1"

    fun isValidParent(coordinate: String) = Coordinate.parseOrNull(coordinate)?.kind == Kinds.COMMUNITY
    fun isValidChild(coordinate: String) = Coordinate.parseOrNull(coordinate)?.kind == Kinds.CALENDAR_EVENT

    /** Both newest configs name each other (§15.1). */
    fun isLinked(parent: String, parentCfg: EventConfig, child: String, childCfg: EventConfig): Boolean =
        isValidParent(parent) && isValidChild(child) && childCfg.parent == parent && child in parentCfg.children

    /** Who may sign a proof for [child]: its E_id and its current coordinator. */
    fun authorities(child: String, childCfg: EventConfig): List<String> =
        listOfNotNull(Coordinate.parse(child).pubkey, childCfg.coordinator)

    private fun challenge(parent: String, child: String, attendee: String): ByteArray {
        val sb = StringBuilder("[")
        listOf(PROOF_TAG, parent, child, attendee).forEachIndexed { i, s -> if (i > 0) sb.append(','); JsJson.appendQuoted(sb, s) }
        return Bytes.sha256(Bytes.utf8(sb.append(']').toString()))
    }

    data class Proof(val a: String, val by: String, val sig: String)

    fun makeProof(signerSk: ByteArray, parent: String, child: String, attendee: String) =
        Proof(parent, Secp.pubkeyHex(signerSk), Bytes.toHex(Secp.sign(challenge(parent, child, attendee), signerSk)))

    /** Untrusted input: malformed fields return false. */
    fun verifyProof(by: String, sig: String, parent: String, child: String, attendee: String, authorities: List<String>): Boolean {
        if (!by.isHex32() || !sig.isHex64() || !attendee.isHex32() || by !in authorities) return false
        return Secp.verify(Bytes.fromHex(sig), challenge(parent, child, attendee), Bytes.fromHex(by))
    }

    fun memberOfTag(child: String, by: String, sig: String) = listOf(MEMBER_OF_TAG, child, by, sig)

    data class MemberOf(val child: String, val by: String, val sig: String)

    fun parseMemberOf(tags: List<List<String>>): List<MemberOf> =
        tags.filter { it.size >= 4 && it[0] == MEMBER_OF_TAG }
            .map { MemberOf(it[1], it[2], it[3]) }
            .filter { isValidChild(it.child) && it.by.isHex32() && it.sig.isHex64() }
            .take(8)
}
