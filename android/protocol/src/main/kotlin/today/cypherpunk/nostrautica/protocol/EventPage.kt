package today.cypherpunk.nostrautica.protocol

/** Event page helpers (event-page.ts, kinds 31607–31609). */
object EventPage {
    const val MAX_MEMBERS_POST_MARKDOWN_BYTES = 60_000
    const val MAX_THEME_CSS_BYTES = 32 * 1024

    fun encryptMembersPost(eck: ByteArray, post: MembersPostContent): String {
        val md = Bytes.utf8Length(post.content)
        require(md <= MAX_MEMBERS_POST_MARKDOWN_BYTES) {
            "members-only post markdown is $md bytes, over the $MAX_MEMBERS_POST_MARKDOWN_BYTES-byte limit"
        }
        return Nip44.eckEncrypt(eck, Wire.encode(MembersPostContent.serializer(), post))
    }

    fun decryptMembersPost(eck: ByteArray, ciphertext: String): MembersPostContent =
        Wire.parse(MembersPostContent.serializer(), Nip44.eckDecrypt(eck, ciphertext))

    fun encryptPrivate(eck: ByteArray, priv: EventPagePrivate): String =
        Nip44.eckEncrypt(eck, Wire.encode(EventPagePrivate.serializer(), priv))

    fun decryptPrivate(eck: ByteArray, ciphertext: String): EventPagePrivate =
        Wire.parse(EventPagePrivate.serializer(), Nip44.eckDecrypt(eck, ciphertext))

    data class Merged<T>(val item: T, val membersOnly: Boolean)

    /** Interleave members-only items (carrying `pos` in the merged list) into the public list. */
    fun <T> merge(publicItems: List<T>, privateItems: List<Pair<T, Int>>): List<Merged<T>> {
        val merged = publicItems.map { Merged(it, false) }.toMutableList()
        for ((item, pos) in privateItems.sortedBy { it.second }) {
            merged.add(pos.coerceIn(0, merged.size), Merged(item, true))
        }
        return merged
    }

    fun <T> split(merged: List<Merged<T>>): Pair<List<T>, List<Pair<T, Int>>> {
        val pub = mutableListOf<T>()
        val priv = mutableListOf<Pair<T, Int>>()
        merged.forEachIndexed { i, m -> if (m.membersOnly) priv += m.item to i else pub += m.item }
        return pub to priv
    }

    fun mergeMenu(publicItems: List<MenuItem>, private: List<MenuItem>): List<Merged<MenuItem>> =
        merge(publicItems, private.map { it.copy(pos = null) to (it.pos ?: 0) })

    fun mergeSections(publicItems: List<PageSection>, private: List<PageSection>): List<Merged<PageSection>> =
        merge(publicItems.map { it.withPos(null) }, private.map { it.withPos(null) to (it.pos ?: 0) })

    fun menuToRTags(items: List<MenuItem>) = items.map { listOf("r", it.target, it.label) }

    fun rTagsToMenu(tags: List<List<String>>) =
        tags.filter { it.size >= 2 && it[0] == "r" }.map { MenuItem(label = it.getOrNull(2) ?: it[1], target = it[1]) }
}
