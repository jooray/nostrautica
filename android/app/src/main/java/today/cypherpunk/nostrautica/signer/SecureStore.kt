package today.cypherpunk.nostrautica.signer

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (the account key, a NIP-46 session, event keys) encrypted with an
 * AES-GCM key that lives in the Android Keystore and never leaves it. The
 * ciphertext sits in app-private SharedPreferences, excluded from backups.
 */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("secure", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    @Synchronized
    fun put(name: String, value: String?) {
        if (value == null) { prefs.edit().remove(name).apply(); return }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(name, b64(c.iv) + ":" + b64(ct)).apply()
    }

    @Synchronized
    fun get(name: String): String? {
        val raw = prefs.getString(name, null) ?: return null
        val (iv, ct) = raw.split(':').takeIf { it.size == 2 } ?: return null
        return runCatching {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, unb64(iv)))
            String(c.doFinal(unb64(ct)), Charsets.UTF_8)
        }.getOrNull()
    }

    fun keys(prefix: String): List<String> = prefs.all.keys.filter { it.startsWith(prefix) }

    fun removePrefix(prefix: String) {
        val e = prefs.edit()
        keys(prefix).forEach { e.remove(it) }
        e.apply()
    }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)

    companion object {
        private const val ALIAS = "nostrautica.secure.v1"
    }
}
