package today.cypherpunk.nostrautica.signer

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (the account key, a NIP-46 session, event keys) encrypted with an
 * AES-GCM key that lives in the Android Keystore and never leaves it. The
 * ciphertext sits in app-private SharedPreferences, excluded from backups.
 *
 * Reads are answered from memory once a value has been decrypted, and [warm]
 * decrypts everything on a background thread at start. Every Keystore operation
 * is a binder call into keystore2 (and on most phones into the TEE), which takes
 * from a few ms to hundreds under load, and screens read event keys while they
 * compose: Home decrypted every held event's record on the main thread on each
 * pass, behind one lock that an IO-thread grants scan or MDK's secret callback
 * could be holding. The plaintext lives only in this process's memory, where the
 * same secrets already sit while they are used.
 */
open class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("secure", Context.MODE_PRIVATE)

    /** Decrypted values; [ABSENT] marks a name known to have no (readable) value. */
    private val memo = ConcurrentHashMap<String, Any>()
    /** Serializes writers and memo updates; never held across a Keystore call on the read path. */
    private val writeLock = Any()
    @Volatile private var cachedKey: SecretKey? = null

    private fun key(): SecretKey {
        cachedKey?.let { return it }
        synchronized(this) {
            cachedKey?.let { return it }
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val k = (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build(),
                )
                generateKey()
            }
            cachedKey = k
            return k
        }
    }

    /** Encrypt for storage (`iv:ciphertext`, both base64). */
    protected open fun seal(value: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        return b64(c.iv) + ":" + b64(ct)
    }

    /** Decrypt what [seal] stored; null when it is unreadable. */
    protected open fun unseal(raw: String): String? {
        val (iv, ct) = raw.split(':').takeIf { it.size == 2 } ?: return null
        return runCatching {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, unb64(iv)))
            String(c.doFinal(unb64(ct)), Charsets.UTF_8)
        }.getOrNull()
    }

    open fun put(name: String, value: String?) = synchronized(writeLock) {
        if (value == null) {
            memo[name] = ABSENT
            prefs.edit().remove(name).apply()
        } else {
            val sealed = seal(value)
            memo[name] = value
            prefs.edit().putString(name, sealed).apply()
        }
    }

    open fun get(name: String): String? {
        memo[name]?.let { return it as? String }
        val raw = prefs.getString(name, null)
        val plain = raw?.let(::unseal)
        // putIfAbsent: a put that landed while this was decrypting the older value wins.
        val v = synchronized(writeLock) { memo.putIfAbsent(name, plain ?: ABSENT) ?: (plain ?: ABSENT) }
        return v as? String
    }

    fun keys(prefix: String): List<String> = prefs.all.keys.filter { it.startsWith(prefix) }

    fun removePrefix(prefix: String) = synchronized(writeLock) {
        val e = prefs.edit()
        keys(prefix).forEach { e.remove(it); memo[it] = ABSENT }
        e.apply()
    }

    /** Decrypt every stored value into memory. Call off the main thread, once at start. */
    fun warm() {
        for (k in prefs.all.keys) runCatching { get(k) }
    }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)

    companion object {
        private const val ALIAS = "nostrautica.secure.v1"
        private val ABSENT = Any()
    }
}
