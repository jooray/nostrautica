package today.cypherpunk.nostrautica.ui.nav

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import today.cypherpunk.nostrautica.BuildConfig

/**
 * Verified https app links (audit DS41-066). Android only opens the invite and event
 * links in the app without a chooser when the manifest asks for verification AND the
 * host serves /.well-known/assetlinks.json naming this package and its signing key.
 * The two halves live in different trees (android/ and web/), so this pins them to
 * each other and to the shared release key that android/tools/release-check.sh checks.
 */
class AppLinksTest {
    // Gradle runs unit tests from the module directory (android/app).
    private val manifest = File("src/main/AndroidManifest.xml")
    private val assetLinks = File("../../web/.well-known/assetlinks.json")

    private val releaseCertSha256 = "79750fb49349ec3729be5a3e825507a15e47c6d987e854ae91d5d50a20b3a24d"
    private val releasePackage = "today.cypherpunk.nostrautica"

    private fun httpsFilters(): List<Element> {
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(manifest)
        val filters = doc.getElementsByTagName("intent-filter")
        return (0 until filters.length).map { filters.item(it) as Element }.filter { f ->
            val data = f.getElementsByTagName("data")
            (0 until data.length).any { (data.item(it) as Element).getAttribute("android:scheme") == "https" }
        }
    }

    @Test fun httpsLinksAskForVerificationOnTheHostThatServesAssetLinks() {
        val filters = httpsFilters()
        assertTrue("no https intent filter found", filters.isNotEmpty())
        for (f in filters) {
            assertEquals("https filter must set autoVerify", "true", f.getAttribute("android:autoVerify"))
            val data = f.getElementsByTagName("data")
            val hosts = (0 until data.length).map { (data.item(it) as Element).getAttribute("android:host") }.filter { it.isNotEmpty() }
            // Android verifies every host of every autoVerify filter; a host without our
            // assetlinks.json would fail verification for all of them.
            assertEquals(listOf("nostrautica.cypherpunk.today"), hosts.distinct())
        }
    }

    @Test fun assetLinksNameThisPackageAndTheReleaseKey() {
        assertTrue("missing ${assetLinks.path}", assetLinks.exists())
        val statements = Json.parseToJsonElement(assetLinks.readText()).jsonArray
        val ours = statements.map { it.jsonObject }.single { s ->
            s["target"]!!.jsonObject["package_name"]!!.jsonPrimitive.content == releasePackage
        }
        assertEquals(
            listOf("delegate_permission/common.handle_all_urls"),
            ours["relation"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        val target = ours["target"]!!.jsonObject
        assertEquals("android_app", target["namespace"]!!.jsonPrimitive.content)
        val prints = target["sha256_cert_fingerprints"]!!.jsonArray.map { it.jsonPrimitive.content }
        // Google's format: uppercase hex pairs separated by colons.
        prints.forEach { assertTrue("bad fingerprint format: $it", Regex("([0-9A-F]{2}:){31}[0-9A-F]{2}").matches(it)) }
        assertEquals(listOf(releaseCertSha256), prints.map { it.replace(":", "").lowercase() })
        // The release applicationId; debug builds append ".debug" and are not verified.
        assertEquals(releasePackage, BuildConfig.APPLICATION_ID.removeSuffix(".debug"))
    }
}
