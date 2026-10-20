package today.cypherpunk.nostrautica.signer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.atomic.AtomicInteger

/**
 * The read path of [SecureStore] is answered from memory: a Keystore decrypt is a
 * binder call that screens were making on the main thread while composing.
 * Robolectric has no AndroidKeyStore, so the cipher is replaced by a reversible
 * stand-in that counts its calls.
 */
@RunWith(RobolectricTestRunner::class)
class SecureStoreMemoTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    private class Counting(ctx: Context) : SecureStore(ctx) {
        val unseals = AtomicInteger()
        override fun seal(value: String) = "x:" + value.reversed()
        override fun unseal(raw: String): String? { unseals.incrementAndGet(); return raw.removePrefix("x:").reversed() }
    }

    private fun fresh(): Counting {
        ctx.getSharedPreferences("secure", Context.MODE_PRIVATE).edit().clear().commit()
        return Counting(ctx)
    }

    @Test fun aWrittenValueIsReadBackWithoutDecrypting() {
        val s = fresh()
        s.put("a", "secret")
        repeat(5) { assertEquals("secret", s.get("a")) }
        assertEquals(0, s.unseals.get())
    }

    @Test fun aStoredValueIsDecryptedOnceThenServedFromMemory() {
        fresh().put("a", "secret")
        val s = Counting(ctx) // a new process: nothing in memory
        repeat(5) { assertEquals("secret", s.get("a")) }
        assertEquals(1, s.unseals.get())
    }

    @Test fun warmDecryptsEverythingSoLaterReadsCostNothing() {
        fresh().apply { put("a", "1"); put("b", "2") }
        val s = Counting(ctx)
        s.warm()
        assertEquals(2, s.unseals.get())
        assertEquals("1", s.get("a")); assertEquals("2", s.get("b")); assertNull(s.get("c"))
        assertEquals(2, s.unseals.get())
    }

    @Test fun deletesAndPrefixRemovalsAreSeenAtOnce() {
        val s = fresh()
        s.put("ek|a|1", "x"); s.put("ek|a|2", "y"); s.put("other", "z")
        s.put("other", null)
        assertNull(s.get("other"))
        s.removePrefix("ek|a|")
        assertNull(s.get("ek|a|1")); assertNull(s.get("ek|a|2"))
        assertEquals(emptyList<String>(), s.keys("ek|a|"))
        // and a new instance (the next launch) agrees
        val next = Counting(ctx)
        assertNull(next.get("ek|a|1")); assertNull(next.get("other"))
    }

    @Test fun anOverwriteReplacesTheRememberedValue() {
        val s = fresh()
        s.put("a", "old")
        assertEquals("old", s.get("a"))
        s.put("a", "new")
        assertEquals("new", s.get("a"))
        assertEquals("new", Counting(ctx).get("a"))
    }
}
