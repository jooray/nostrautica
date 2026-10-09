package today.cypherpunk.nostrautica

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Small per-device preferences (the PWA keeps these in localStorage). */
class AppPrefs(context: Context) {
    private val p = context.getSharedPreferences("prefs", Context.MODE_PRIVATE)

    private val _theme = MutableStateFlow(p.getString("theme", "system") ?: "system")
    /** system | light | dark */
    val theme: StateFlow<String> get() = _theme
    fun setTheme(v: String) { p.edit().putString("theme", v).apply(); _theme.value = v }

    private val _externalImages = MutableStateFlow(p.getBoolean("external_images", true))
    /** Load avatars/banners from third-party hosts (Settings → Privacy). */
    val externalImages: StateFlow<Boolean> get() = _externalImages
    fun setExternalImages(v: Boolean) { p.edit().putBoolean("external_images", v).apply(); _externalImages.value = v }

    fun getString(key: String): String? = p.getString(key, null)
    fun putString(key: String, value: String?) = p.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    fun getLong(key: String): Long = p.getLong(key, 0)
    fun putLong(key: String, value: Long) = p.edit().putLong(key, value).apply()
    fun getBool(key: String): Boolean = p.getBoolean(key, false)
    fun putBool(key: String, value: Boolean) = p.edit().putBoolean(key, value).apply()
}
