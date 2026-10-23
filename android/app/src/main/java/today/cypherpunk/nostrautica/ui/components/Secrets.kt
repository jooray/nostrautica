package today.cypherpunk.nostrautica.ui.components

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.os.PersistableBundle
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext

/**
 * Secret surfaces (audit R-73): only the screens that show a secret, never the
 * whole app, so screenshots of everything else keep working for bug reports.
 */
object Secrets {
    private var secureHolders = 0

    /**
     * Put a secret on the clipboard marked sensitive (ClipDescription.EXTRA_IS_SENSITIVE,
     * spelled out because the constant is API 33 and minSdk is 26): Android 13+ then hides
     * it in the copy preview, and keyboards that honour the flag don't suggest it.
     */
    fun copy(context: Context, text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        val clip = ClipData.newPlainText("", text)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        cm.setPrimaryClip(clip)
    }

    /** FLAG_SECURE on [activity] while at least one secret surface is up. */
    internal fun hold(activity: Activity, on: Boolean) {
        secureHolders = maxOf(0, secureHolders + if (on) 1 else -1)
        if (secureHolders > 0) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    internal tailrec fun activityOf(context: Context): Activity? = when (context) {
        is Activity -> context
        is ContextWrapper -> activityOf(context.baseContext)
        else -> null
    }
}

/** While this is composed, the window can't be screenshotted, recorded or shown in Recents. */
@Composable
fun SecureWindow() {
    val activity = Secrets.activityOf(LocalContext.current) ?: return
    DisposableEffect(activity) {
        Secrets.hold(activity, true)
        onDispose { Secrets.hold(activity, false) }
    }
}
