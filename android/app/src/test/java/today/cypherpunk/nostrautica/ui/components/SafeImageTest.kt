package today.cypherpunk.nostrautica.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Audit R-67: one gate for every remote image, preference first. */
class SafeImageTest {
    @Test fun thePreferenceOffLoadsNothing() {
        assertNull(safeImageSrc("https://cdn.example/logo.png", allowed = false))
    }

    @Test fun onlyHttpsWithAHostAndNoUserinfo() {
        assertEquals("https://cdn.example/logo.png", safeImageSrc(" https://cdn.example/logo.png", allowed = true)?.trim())
        for (bad in listOf("http://cdn.example/a.png", "file:///sdcard/a.png", "content://x/1", "https://user@cdn.example/a.png", "https:///a.png", "not a url", "", null)) {
            assertNull(bad, safeImageSrc(bad, allowed = true))
        }
    }
}
