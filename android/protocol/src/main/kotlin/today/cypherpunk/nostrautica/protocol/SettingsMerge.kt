package today.cypherpunk.nostrautica.protocol

/**
 * Commutative merge of the user-private per-event settings across one account's
 * devices (audit SB-88). Port of packages/protocol/src/settings-merge.ts, which is
 * the reference; tools/vectors/parity.mjs checks the two agree.
 *
 * Every entry carries the ms stamp of its last change (`clock`); an entry stamped
 * but absent from its list is a tombstone; entries the clock does not name carry
 * `base`. A clock-less payload (an older client) is read as a whole-document write
 * at its event's created_at. Merge = per-entry newest stamp, add-wins on a tie,
 * greater note text on a full tie.
 */
object SettingsMerge {
    enum class Field { FAVORITES, WANT_TO_MEET, MET }

    sealed interface Edit {
        data class Toggle(val list: Field, val pubkey: String) : Edit
        data class Note(val pubkey: String, val note: String) : Edit
    }

    private data class Entry(val present: Boolean, val at: Long, val text: String? = null)

    private class Normalized(
        val base: Long,
        val lists: Map<Field, MutableMap<String, Entry>>,
        val notes: MutableMap<String, Entry>,
        val oddNotes: Map<String, String>,
    )

    private val HEX32 = Regex("^[0-9a-f]{64}$")

    private fun PerEventSettings.list(f: Field) = when (f) {
        Field.FAVORITES -> favorites
        Field.WANT_TO_MEET -> wantToMeet
        Field.MET -> met
    }

    private fun SettingsClock?.stamps(f: Field): Map<String, Long> = when (f) {
        Field.FAVORITES -> this?.favorites
        Field.WANT_TO_MEET -> this?.wantToMeet
        Field.MET -> this?.met
    } ?: emptyMap()

    private fun normalize(s: PerEventSettings, createdAt: Long): Normalized {
        val clock = s.clock
        val base = if (clock != null) (s.base ?: 0L) else maxOf(0L, createdAt) * 1000L
        val lists = Field.entries.associateWith { f ->
            val m = LinkedHashMap<String, Entry>()
            val stamps = clock.stamps(f)
            for (pk in s.list(f)) m[pk] = Entry(true, stamps[pk] ?: base)
            for ((pk, at) in stamps) if (pk !in m) m[pk] = Entry(false, at)
            m
        }
        val notes = LinkedHashMap<String, Entry>()
        val odd = LinkedHashMap<String, String>()
        val noteStamps = clock?.notes ?: emptyMap()
        for ((pk, text) in s.notes) {
            if (HEX32.matches(pk)) notes[pk] = Entry(true, noteStamps[pk] ?: base, text) else odd[pk] = text
        }
        for ((pk, at) in noteStamps) if (pk !in notes) notes[pk] = Entry(false, at)
        return Normalized(base, lists, notes, odd)
    }

    private fun win(a: Entry, b: Entry): Entry {
        if (a.at != b.at) return if (a.at > b.at) a else b
        if (a.present != b.present) return if (a.present) a else b
        val ta = a.text ?: ""
        val tb = b.text ?: ""
        if (ta != tb) return if (ta > tb) a else b
        return a
    }

    private fun mergeMaps(a: Map<String, Entry>, aBase: Long, b: Map<String, Entry>, bBase: Long): MutableMap<String, Entry> {
        val out = LinkedHashMap<String, Entry>()
        for (k in (a.keys + b.keys)) out[k] = win(a[k] ?: Entry(false, aBase), b[k] ?: Entry(false, bBase))
        return out
    }

    private fun emit(m: Map<String, Entry>, base: Long, onPresent: (String, Entry) -> Unit): Map<String, Long> {
        val ordered = m.entries.sortedWith(compareBy<Map.Entry<String, Entry>> { it.value.at }.thenBy { it.key })
        val tombs = ordered.filter { !it.value.present && it.value.at > base }
        val keep = tombs.takeLast(Limits.MAX_SETTINGS_TOMBSTONES).map { it.key }.toSet()
        val stamps = LinkedHashMap<String, Long>()
        for ((pk, e) in ordered) {
            if (e.present) { stamps[pk] = e.at; onPresent(pk, e) } else if (pk in keep) stamps[pk] = e.at
        }
        return stamps
    }

    private fun denormalize(n: Normalized): PerEventSettings {
        val lists = Field.entries.associateWith { mutableListOf<String>() }
        val stamps = Field.entries.associateWith { f -> emit(n.lists.getValue(f), n.base) { pk, _ -> lists.getValue(f) += pk } }
        val notes = LinkedHashMap<String, String>()
        val noteStamps = emit(n.notes, n.base) { pk, e -> notes[pk] = e.text ?: "" }
        for ((k, t) in n.oddNotes) if (k !in notes) notes[k] = t
        return PerEventSettings(
            favorites = lists.getValue(Field.FAVORITES),
            wantToMeet = lists.getValue(Field.WANT_TO_MEET),
            met = lists.getValue(Field.MET),
            notes = notes,
            clock = SettingsClock(stamps.getValue(Field.FAVORITES), stamps.getValue(Field.WANT_TO_MEET), stamps.getValue(Field.MET), noteStamps),
            base = n.base,
        )
    }

    /** Merge two copies of one settings document; [aAt]/[bAt] are their events' created_at (s). */
    fun merge(a: PerEventSettings, aAt: Long, b: PerEventSettings, bAt: Long): PerEventSettings {
        val na = normalize(a, aAt)
        val nb = normalize(b, bAt)
        return denormalize(
            Normalized(
                maxOf(na.base, nb.base),
                Field.entries.associateWith { f -> mergeMaps(na.lists.getValue(f), na.base, nb.lists.getValue(f), nb.base) },
                mergeMaps(na.notes, na.base, nb.notes, nb.base),
                nb.oddNotes + na.oddNotes,
            ),
        )
    }

    /** Apply one edit stamped [nowMs], or just past the entry's stamp and `base`. */
    fun edit(doc: PerEventSettings, docAt: Long, edit: Edit, nowMs: Long): PerEventSettings {
        val n = normalize(doc, docAt)
        val (map, pk) = when (edit) {
            is Edit.Toggle -> n.lists.getValue(edit.list) to edit.pubkey
            is Edit.Note -> n.notes to edit.pubkey
        }
        val cur = map[pk] ?: Entry(false, n.base)
        val at = maxOf(nowMs, cur.at + 1, n.base + 1)
        map[pk] = when (edit) {
            is Edit.Toggle -> Entry(!cur.present, at)
            is Edit.Note -> edit.note.trim().let { if (it.isNotEmpty()) Entry(true, at, it) else Entry(false, at) }
        }
        return denormalize(n)
    }

    fun empty(): PerEventSettings = PerEventSettings(clock = SettingsClock(), base = 0L)
}
