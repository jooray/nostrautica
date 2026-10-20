package today.cypherpunk.nostrautica.ui.nav

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Which links the app claims (audit SB-36, SB-37, SB-50, DS41-066) and what they open. */
@RunWith(RobolectricTestRunner::class)
class DeepLinkTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val naddr = "naddr1qvzqqqrukvpzpczuus67gchv2qc5xvzladkqpcr28t2jl0unn6zuvhe6wedm0w4vqyxhwumn8ghj7mn0wvhxcmmvqq9hqmrpdckkyw3jxqervckdkaj"

    private fun claims(uri: String): Boolean {
        val i = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(ctx.packageName)
        return ctx.packageManager.queryIntentActivities(i, 0).isNotEmpty()
    }

    @Test fun claimsOnlyTheLinksItCanOpen() {
        assertTrue(claims("nostr:$naddr"))
        assertTrue(claims("https://nostrautica.cypherpunk.today/app/#/e/$naddr"))
        // Other NIP-19 entities go to a Nostr client or the njump.me fallback instead of a dead tap.
        for (other in listOf("nostr:npub1abc", "nostr:nevent1abc", "nostr:note1abc", "nostr:nprofile1abc")) {
            assertTrue("$other must not be claimed", !claims(other))
        }
        // The custom scheme had no use and was an exported entry point for login?nsec=.
        assertTrue(!claims("nostrautica://login?nsec=nsec1xyz"))
    }

    @Test fun routes() {
        assertEquals(Route.Event(naddr), Route.fromUri(Uri.parse("nostr:$naddr"))?.first)
        assertEquals(Route.Join(naddr, "c0de") to "sk", Route.fromUri(Uri.parse("https://nostrautica.cypherpunk.today/app/#/e/$naddr/join?code=c0de&lang=sk")))
        assertNull(Route.fromUri(Uri.parse("nostrautica://login?nsec=nsec1xyz")))
    }
}
