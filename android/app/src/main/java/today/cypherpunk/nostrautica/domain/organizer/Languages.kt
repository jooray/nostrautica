package today.cypherpunk.nostrautica.domain.organizer

import java.text.Normalizer
import java.util.Locale

/** ISO 639-1 languages (protocol languages.ts), alphabetical by English name. */
object Languages {
    data class L(val code: String, val name: String)

    val ALL: List<L> = listOf(
        L("ab", "Abkhazian"),
        L("aa", "Afar"),
        L("af", "Afrikaans"),
        L("ak", "Akan"),
        L("sq", "Albanian"),
        L("am", "Amharic"),
        L("ar", "Arabic"),
        L("an", "Aragonese"),
        L("hy", "Armenian"),
        L("as", "Assamese"),
        L("av", "Avaric"),
        L("ae", "Avestan"),
        L("ay", "Aymara"),
        L("az", "Azerbaijani"),
        L("bm", "Bambara"),
        L("ba", "Bashkir"),
        L("eu", "Basque"),
        L("be", "Belarusian"),
        L("bn", "Bengali"),
        L("bi", "Bislama"),
        L("bs", "Bosnian"),
        L("br", "Breton"),
        L("bg", "Bulgarian"),
        L("my", "Burmese"),
        L("ca", "Catalan"),
        L("ch", "Chamorro"),
        L("ce", "Chechen"),
        L("ny", "Chichewa"),
        L("zh", "Chinese"),
        L("cu", "Church Slavonic"),
        L("cv", "Chuvash"),
        L("kw", "Cornish"),
        L("co", "Corsican"),
        L("cr", "Cree"),
        L("hr", "Croatian"),
        L("cs", "Czech"),
        L("da", "Danish"),
        L("dv", "Divehi"),
        L("nl", "Dutch"),
        L("dz", "Dzongkha"),
        L("en", "English"),
        L("eo", "Esperanto"),
        L("et", "Estonian"),
        L("ee", "Ewe"),
        L("fo", "Faroese"),
        L("fj", "Fijian"),
        L("fi", "Finnish"),
        L("fr", "French"),
        L("fy", "Western Frisian"),
        L("ff", "Fulah"),
        L("gd", "Scottish Gaelic"),
        L("gl", "Galician"),
        L("lg", "Ganda"),
        L("ka", "Georgian"),
        L("de", "German"),
        L("el", "Greek"),
        L("kl", "Kalaallisut"),
        L("gn", "Guarani"),
        L("gu", "Gujarati"),
        L("ht", "Haitian Creole"),
        L("ha", "Hausa"),
        L("he", "Hebrew"),
        L("hz", "Herero"),
        L("hi", "Hindi"),
        L("ho", "Hiri Motu"),
        L("hu", "Hungarian"),
        L("is", "Icelandic"),
        L("io", "Ido"),
        L("ig", "Igbo"),
        L("id", "Indonesian"),
        L("ia", "Interlingua"),
        L("ie", "Interlingue"),
        L("iu", "Inuktitut"),
        L("ik", "Inupiaq"),
        L("ga", "Irish"),
        L("it", "Italian"),
        L("ja", "Japanese"),
        L("jv", "Javanese"),
        L("kn", "Kannada"),
        L("kr", "Kanuri"),
        L("ks", "Kashmiri"),
        L("kk", "Kazakh"),
        L("km", "Khmer"),
        L("ki", "Kikuyu"),
        L("rw", "Kinyarwanda"),
        L("ky", "Kyrgyz"),
        L("kv", "Komi"),
        L("kg", "Kongo"),
        L("ko", "Korean"),
        L("kj", "Kuanyama"),
        L("ku", "Kurdish"),
        L("lo", "Lao"),
        L("la", "Latin"),
        L("lv", "Latvian"),
        L("li", "Limburgish"),
        L("ln", "Lingala"),
        L("lt", "Lithuanian"),
        L("lu", "Luba-Katanga"),
        L("lb", "Luxembourgish"),
        L("mk", "Macedonian"),
        L("mg", "Malagasy"),
        L("ms", "Malay"),
        L("ml", "Malayalam"),
        L("mt", "Maltese"),
        L("gv", "Manx"),
        L("mi", "Māori"),
        L("mr", "Marathi"),
        L("mh", "Marshallese"),
        L("mn", "Mongolian"),
        L("na", "Nauru"),
        L("nv", "Navajo"),
        L("nd", "North Ndebele"),
        L("nr", "South Ndebele"),
        L("ng", "Ndonga"),
        L("ne", "Nepali"),
        L("no", "Norwegian"),
        L("nb", "Norwegian Bokmål"),
        L("nn", "Norwegian Nynorsk"),
        L("oc", "Occitan"),
        L("oj", "Ojibwe"),
        L("or", "Odia"),
        L("om", "Oromo"),
        L("os", "Ossetian"),
        L("pi", "Pali"),
        L("ps", "Pashto"),
        L("fa", "Persian"),
        L("pl", "Polish"),
        L("pt", "Portuguese"),
        L("pa", "Punjabi"),
        L("qu", "Quechua"),
        L("ro", "Romanian"),
        L("rm", "Romansh"),
        L("rn", "Rundi"),
        L("ru", "Russian"),
        L("se", "Northern Sami"),
        L("sm", "Samoan"),
        L("sg", "Sango"),
        L("sa", "Sanskrit"),
        L("sc", "Sardinian"),
        L("sr", "Serbian"),
        L("sn", "Shona"),
        L("sd", "Sindhi"),
        L("si", "Sinhala"),
        L("sk", "Slovak"),
        L("sl", "Slovenian"),
        L("so", "Somali"),
        L("st", "Southern Sotho"),
        L("es", "Spanish"),
        L("su", "Sundanese"),
        L("sw", "Swahili"),
        L("ss", "Swati"),
        L("sv", "Swedish"),
        L("tl", "Tagalog"),
        L("ty", "Tahitian"),
        L("tg", "Tajik"),
        L("ta", "Tamil"),
        L("tt", "Tatar"),
        L("te", "Telugu"),
        L("th", "Thai"),
        L("bo", "Tibetan"),
        L("ti", "Tigrinya"),
        L("to", "Tongan"),
        L("ts", "Tsonga"),
        L("tn", "Tswana"),
        L("tr", "Turkish"),
        L("tk", "Turkmen"),
        L("tw", "Twi"),
        L("ug", "Uyghur"),
        L("uk", "Ukrainian"),
        L("ur", "Urdu"),
        L("uz", "Uzbek"),
        L("ve", "Venda"),
        L("vi", "Vietnamese"),
        L("vo", "Volapük"),
        L("wa", "Walloon"),
        L("cy", "Welsh"),
        L("wo", "Wolof"),
        L("xh", "Xhosa"),
        L("ii", "Sichuan Yi"),
        L("yi", "Yiddish"),
        L("yo", "Yoruba"),
        L("za", "Zhuang"),
        L("zu", "Zulu"),
    )

    private val byCode = ALL.associateBy { it.code }

    fun isKnown(code: String) = code in byCode

    /** Strip diacritics and lowercase, so "slovencina" finds "Slovenčina". */
    fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()

    /** The localized name in the UI locale (LanguagePicker.svelte displayName), else English. */
    fun displayName(code: String, uiLocale: String): String {
        val english = byCode[code]?.name ?: code
        val n = runCatching { Locale.forLanguageTag(code).getDisplayLanguage(Locale.forLanguageTag(uiLocale)) }.getOrNull()
        return if (!n.isNullOrBlank() && n.lowercase() != code) n.replaceFirstChar { it.titlecase(Locale.forLanguageTag(uiLocale)) } else english
    }

    data class Option(val code: String, val label: String, val search: String)

    /**
     * Picker options: the UI locale, the phone languages, then the app locales,
     * pinned on top; everything else alphabetical by displayed name.
     */
    fun options(uiLocale: String, phoneLanguages: List<String>, appLocales: List<String>): Pair<List<Option>, Int> {
        val pinned = (listOf(uiLocale) + phoneLanguages.map { it.take(2).lowercase() } + appLocales).filter(::isKnown).distinct()
        fun opt(code: String): Option {
            val shown = displayName(code, uiLocale)
            return Option(code, "$shown ($code)", "${fold(shown)} ${fold(byCode[code]!!.name)} $code")
        }
        val collator = java.text.Collator.getInstance(Locale.forLanguageTag(uiLocale))
        val rest = ALL.filter { it.code !in pinned }.map { opt(it.code) }.sortedWith { a, b -> collator.compare(a.label, b.label) }
        return (pinned.map(::opt) + rest) to pinned.size
    }

    fun filter(options: List<Option>, query: String): List<Option> {
        val q = fold(query.trim())
        return if (q.isEmpty()) options else options.filter { q in it.search }
    }
}
