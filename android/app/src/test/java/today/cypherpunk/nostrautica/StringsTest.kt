package today.cypherpunk.nostrautica

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every string key the Kotlin code asks for exists in the catalog (generated from
 * the PWA's messages.ts plus tools/strings/app-messages.json), and every locale
 * has every key the English catalog has.
 */
class StringsTest {
    private val root = File("src/main").let { if (it.exists()) it else File("app/src/main") }
    private fun catalog(locale: String): Map<String, String> =
        Json.parseToJsonElement(File(root, "assets/i18n/$locale.json").readText()).jsonObject.mapValues { it.value.toString() }

    private val call = Regex("""\b(t|tc|tp|tcp)\(\s*"([a-zA-Z0-9_.\-]+)"""")

    @Test fun everyUsedKeyExists() {
        val en = catalog("en")
        val missing = mutableListOf<String>()
        root.resolve("java").walkTopDown().filter { it.extension == "kt" }.forEach { f ->
            for (m in call.findAll(f.readText())) {
                val (fn, key) = m.destructured
                val ok = when (fn) {
                    "tp", "tcp" -> listOf("one", "few", "many").any { "$key.$it" in en }
                    else -> key in en
                }
                if (!ok) missing += "${f.name}: $fn(\"$key\")"
            }
        }
        assertTrue("missing string keys:\n" + missing.distinct().joinToString("\n"), missing.isEmpty())
    }

    @Test fun everyLocaleIsComplete() {
        val en = catalog("en").keys.filterNot { it.endsWith(".few") }
        for (l in listOf("sk", "cs", "de", "es")) {
            val c = catalog(l)
            val missing = en.filter { it !in c && !(it.endsWith(".one") || it.endsWith(".many")) }
            assertTrue("$l is missing ${missing.take(20)}", missing.isEmpty())
        }
    }
}
