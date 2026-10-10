package today.cypherpunk.nostrautica.domain.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaRulesTest {
    @Test fun precheck() {
        assertNull(Precheck.check(1000, 80.0, 90))
        assertEquals(Precheck.Violation("duration", 90, 91), Precheck.check(1000, 91.2, 90))
        // Unknown (0 / non-finite) duration is never a rejection; 0 = unlimited.
        assertNull(Precheck.check(1000, Double.POSITIVE_INFINITY, 90))
        assertNull(Precheck.check(1000, Double.NaN, 90))
        assertNull(Precheck.check(1000, 5000.0, 0))
        assertEquals("size", Precheck.check(Precheck.MAX_UPLOAD_BYTES + 1, 10.0, 90)?.kind)
        assertEquals(0, Precheck.normalizeDurationSec(-3.0))
        assertEquals(12, Precheck.normalizeDurationSec(11.6))
    }

    @Test fun externalUrls() {
        assertEquals("youtube", ExternalUrl.classify("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.kind)
        assertEquals("dQw4w9WgXcQ", ExternalUrl.youTubeId("https://youtu.be/dQw4w9WgXcQ"))
        assertEquals("dQw4w9WgXcQ", ExternalUrl.youTubeId("https://youtube.com/shorts/dQw4w9WgXcQ"))
        assertEquals("dQw4w9WgXcQ", ExternalUrl.youTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ?start=3"))
        // A YouTube host without a video id is rejected, not treated as a file.
        assertNull(ExternalUrl.classify("https://www.youtube.com/channel/abc"))
        assertEquals("video", ExternalUrl.classify("https://cdn.example.com/talk.mp4")?.kind)
        assertNull(ExternalUrl.classify("http://cdn.example.com/talk.mp4"))
        assertNull(ExternalUrl.classify("https://user:pass@cdn.example.com/talk.mp4"))
        assertNull(ExternalUrl.classify("not a url"))
    }

    @Test fun galleryIsNewestFirst() {
        val items = listOf("a", "b", "c", "d")
        // Unstamped: stored order reversed.
        assertEquals(listOf("d", "c", "b", "a"), LibraryOrder.order(items, { it }, emptyMap()))
        // Stamped pairs by date; mixed falls back to position.
        assertEquals(listOf("d", "c", "a", "b"), LibraryOrder.order(items, { it }, mapOf("a" to 300L, "b" to 100L)))
    }

    @Test fun videoRules() {
        assertEquals(720 to 1280, VideoRules.targetSize(1080, 1920))
        assertEquals(1280 to 720, VideoRules.targetSize(3840, 2160))
        assertEquals(640 to 480, VideoRules.targetSize(640, 480))
        assertEquals(480 to 852, VideoRules.targetSize(481, 853))
        assertTrue(VideoRules.needsReencode(1080, 1920, 30f, 0))
        assertTrue(VideoRules.needsReencode(720, 1280, 60f, 0))
        assertFalse(VideoRules.needsReencode(720, 1280, 30f, 2_000_000))
        assertEquals(1_000_000, VideoRules.bitrate(720, 1280, 30f, 1_000_000))
        assertEquals(2_211_840, VideoRules.bitrate(720, 1280, 30f, 0))
        assertEquals(800_000, VideoRules.bitrate(100, 100, 30f, 0))
    }

    @Test fun captureClock() {
        assertEquals(90, CaptureClock.tick(0, 90))
        assertEquals(89, CaptureClock.tick(1_200, 90))
        assertEquals(0, CaptureClock.tick(120_000, 90))
        assertEquals(42, CaptureClock.tick(42_900, 0))
    }
}
