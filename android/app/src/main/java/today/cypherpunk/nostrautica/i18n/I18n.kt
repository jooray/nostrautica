package today.cypherpunk.nostrautica.i18n

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale

/**
 * The PWA's i18n runtime (packages/app/src/lib/i18n/i18n.svelte.ts) over the same
 * catalogs, generated into assets/i18n by tools/strings/generate.mjs. Same rules:
 *
 * - lookup falls back locale → en → the key itself;
 * - `{name}` placeholders, filled from params (unknown ones are left as typed);
 * - plurals via `.one/.few/.many` (sk/cs: 1 / 2–4 / 5+; others one/many),
 *   falling back to `.many`, then `.one`;
 * - community variants: `<key>.community` when the space is a community;
 * - locale precedence: an explicit Settings choice, then an invite link's
 *   `lang=` (remembered as a soft default), then the phone's language. An event's
 *   language is adopted for the session unless the user chose explicitly.
 */
class I18n(private val context: Context) {
    data class Strings(val locale: String, private val catalog: Map<String, String>, private val en: Map<String, String>) {
        fun raw(key: String): String = catalog[key] ?: en[key] ?: key
        fun has(key: String): Boolean = en.containsKey(key)
        fun hasPlural(base: String) = listOf("one", "few", "many").any { en.containsKey("$base.$it") }

        fun t(key: String, vararg params: Pair<String, Any>): String = interpolate(raw(key), params.toMap())

        fun tp(base: String, n: Int, vararg params: Pair<String, Any>): String {
            val cat = pluralCategory(locale, n)
            val raw = listOf("$base.$cat", "$base.many", "$base.one").firstNotNullOfOrNull { catalog[it] ?: en[it] } ?: base
            return interpolate(raw, mapOf("n" to n) + params.toMap())
        }

        /** Community wording when [community] and a `.community` variant exists. */
        fun tc(key: String, community: Boolean, vararg params: Pair<String, Any>): String =
            if (community && has("$key.community")) t("$key.community", *params) else t(key, *params)

        fun tcp(base: String, community: Boolean, n: Int, vararg params: Pair<String, Any>): String =
            if (community && hasPlural("$base.community")) tp("$base.community", n, *params) else tp(base, n, *params)
    }

    private val prefs = context.getSharedPreferences("i18n", Context.MODE_PRIVATE)
    private val catalogs = HashMap<String, Map<String, String>>()
    val locales: List<String>
    val localeNames: Map<String, String>

    private val _strings: MutableStateFlow<Strings>
    val strings: StateFlow<Strings> get() = _strings

    /** True once the user picked a language in Settings. */
    var explicit: Boolean = false
        private set

    init {
        val meta = Json.parseToJsonElement(asset("i18n/locales.json")).jsonObject
        locales = meta["locales"]!!.jsonArray.map { it.jsonPrimitive.content }
        localeNames = meta["names"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        val chosen = asLocale(prefs.getString(KEY_EXPLICIT, null))
        explicit = chosen != null
        val start = chosen ?: asLocale(prefs.getString(KEY_DEFAULT, null)) ?: asLocale(Locale.getDefault().language) ?: "en"
        _strings = MutableStateFlow(build(start))
    }

    private fun asset(path: String) = context.assets.open(path).bufferedReader().use { it.readText() }

    private fun catalog(locale: String): Map<String, String> = catalogs.getOrPut(locale) {
        (Json.parseToJsonElement(asset("i18n/$locale.json")) as JsonObject).mapValues { it.value.jsonPrimitive.content }
    }

    private fun build(locale: String) = Strings(locale, catalog(locale), catalog("en"))

    fun asLocale(value: String?): String? {
        val base = value?.trim()?.take(2)?.lowercase() ?: return null
        return base.takeIf { it in locales }
    }

    val locale: String get() = _strings.value.locale

    /** Settings: an explicit choice outranks everything and is remembered. */
    fun set(locale: String) {
        val l = asLocale(locale) ?: return
        explicit = true
        prefs.edit().putString(KEY_EXPLICIT, l).apply()
        _strings.value = build(l)
    }

    /** An invite link's `lang=`: a remembered soft default, never over an explicit choice. */
    fun adoptInviteLang(lang: String?) {
        val l = asLocale(lang) ?: return
        prefs.edit().putString(KEY_DEFAULT, l).apply()
        if (!explicit) _strings.value = build(l)
    }

    /** An event's language, for this session only, unless the user chose explicitly. */
    fun adoptEventLang(lang: String?) {
        if (explicit) return
        val l = asLocale(lang) ?: return
        if (l != locale) _strings.value = build(l)
    }

    companion object {
        private const val KEY_EXPLICIT = "lang"
        private const val KEY_DEFAULT = "lang_default"

        fun pluralCategory(locale: String, n: Int): String {
            val abs = kotlin.math.abs(n)
            return if (locale == "sk" || locale == "cs") {
                when { abs == 1 -> "one"; abs in 2..4 -> "few"; else -> "many" }
            } else if (abs == 1) "one" else "many"
        }

        private val PLACEHOLDER = Regex("\\{(\\w+)\\}")

        fun interpolate(template: String, params: Map<String, Any>): String =
            if (params.isEmpty()) template
            else PLACEHOLDER.replace(template) { m -> params[m.groupValues[1]]?.toString() ?: m.value }
    }
}

val LocalStrings = staticCompositionLocalOf<I18n.Strings> { error("no strings") }

/** The current catalog; recomposes when the language changes. */
@Composable
fun rememberStrings(i18n: I18n): I18n.Strings {
    val s by i18n.strings.collectAsState()
    return s
}
