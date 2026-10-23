package today.cypherpunk.nostrautica.ui.components

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.view.WindowManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** Audit R-73: secrets are copied as sensitive, and their screens are FLAG_SECURE only while shown. */
@RunWith(RobolectricTestRunner::class)
class SecretsTest {
    @Test fun aCopiedSecretIsMarkedSensitive() {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        Secrets.copy(ctx, "nsec1secret")
        val clip = (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip!!
        assertEquals("nsec1secret", clip.getItemAt(0).text)
        assertTrue(clip.description.extras!!.getBoolean("android.content.extra.IS_SENSITIVE"))
    }

    @Test fun flagSecureLastsWhileAnySecretSurfaceIsUp() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        fun secure() = activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
        Secrets.hold(activity, true)
        Secrets.hold(activity, true)
        Secrets.hold(activity, false)
        assertTrue(secure())
        Secrets.hold(activity, false)
        assertEquals(false, secure())
    }
}
