package today.cypherpunk.nostrautica.domain.content

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * WebVTT captions from a plain-text transcript (media/vtt.ts). The wire format
 * has no segment timing, so the text is spread over the media's duration in
 * proportion to each chunk's length: pseudo-cues that land within a few seconds
 * of when each sentence is said, instead of one cue covering the whole talk.
 */
object Vtt {
    private const val TARGET_CUE_CHARS = 180
    private const val MIN_CUE_SEC = 2

    fun timestamp(seconds: Double): String {
        val s = if (seconds.isFinite()) max(0.0, seconds) else 0.0
        var total = floor(s).toLong()
        var ms = ((s - floor(s)) * 1000).roundToLong()
        if (ms >= 1000) { total += 1; ms -= 1000 }
        return String.format(java.util.Locale.ROOT, "%02d:%02d:%02d.%03d", total / 3600, (total % 3600) / 60, total % 60, ms)
    }

    /** A blank line ends a cue, so paragraphs collapse to single newlines; `&<>` are cue markup. */
    private fun escapeCue(text: String): String = text
        .replace(Regex("\r\n?"), "\n")
        .replace(Regex("\n[ \t]*(?:\n[ \t]*)+"), "\n")
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    fun singleCue(text: String, durationSec: Double = 86_400.0): String {
        val body = escapeCue(text.trim())
        if (body.isEmpty()) return "WEBVTT\n"
        return "WEBVTT\n\n${timestamp(0.0)} --> ${timestamp(durationSec)}\n$body\n"
    }

    /** Whole words into at most [maxCues] even chunks, preferring sentence ends. */
    fun splitForCues(text: String, maxCues: Int): List<String> {
        val words = text.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        if (maxCues <= 1) return listOf(words.joinToString(" "))
        val target = max(1, ceil(text.trim().length.toDouble() / maxCues).toInt())
        val chunks = mutableListOf<String>()
        var current = ""
        val sentenceEnd = Regex("""[.!?…](["')\]]|”)?$""")
        for (word in words) {
            current = if (current.isEmpty()) word else "$current $word"
            val endsSentence = sentenceEnd.containsMatchIn(word)
            val full = current.length >= target
            if (chunks.size + 1 < maxCues && ((endsSentence && current.length >= target * 0.6) || full)) {
                chunks += current
                current = ""
            }
        }
        if (current.isNotEmpty()) chunks += current
        return chunks
    }

    data class Segment(val start: Double, val end: Double, val text: String)

    fun segments(list: List<Segment>): String {
        val cues = list.filter { it.text.isNotBlank() }.mapIndexed { i, s ->
            "${i + 1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${escapeCue(s.text.trim())}"
        }
        return "WEBVTT\n\n${cues.joinToString("\n\n")}\n"
    }

    fun timedCues(text: String, durationSec: Double): String {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return "WEBVTT\n"
        val byText = ceil(trimmed.length.toDouble() / TARGET_CUE_CHARS).toInt()
        val byTime = max(1, floor(durationSec / MIN_CUE_SEC).toInt())
        val chunks = splitForCues(trimmed, max(1, min(byText, byTime)))
        if (chunks.size <= 1) return singleCue(trimmed, durationSec)
        val totalChars = chunks.sumOf { it.length }.toDouble()
        var elapsed = 0.0
        val segs = chunks.mapIndexed { i, chunk ->
            val start = elapsed
            elapsed = if (i == chunks.size - 1) durationSec else start + (chunk.length / totalChars) * durationSec
            Segment(start, elapsed, chunk)
        }
        return segments(segs)
    }

    /** With a usable duration, several timed cues; without one, a single long cue. */
    fun forTranscript(text: String, durationSec: Double?): String =
        if (durationSec != null && durationSec.isFinite() && durationSec > 0) timedCues(text, durationSec) else singleCue(text)
}
