package today.cypherpunk.nostrautica

import android.app.Application
import android.os.StrictMode
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class NostrauticaApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) { enableStrictMode(); MainThreadWatchdog.start() }
        container = AppContainer(this)
        container.session.restore()
        // Every other secret (event keys, chat device keys) into memory, off the main
        // thread, before screens start reading them while they compose.
        Thread({ container.secure.warm() }, "secure-warm").start()
        // Relays are used only while the app is on screen: sockets close shortly
        // after it goes to the background, and nothing polls while it is there.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = container.nostr.onForeground()
            override fun onStop(owner: LifecycleOwner) = container.nostr.onBackground()
        })
    }

    /**
     * Debug builds only: log every disk read/write, network call and slow call made
     * on the main thread, and every leaked closeable, so a regression that could
     * freeze the UI (an ANR on a slow phone) shows up in `adb logcat -s StrictMode`
     * during ordinary testing. Log only, never crash: a third-party library's
     * violation must not stop a test run.
     */
    private fun enableStrictMode() {
        StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build())
        StrictMode.setVmPolicy(
            StrictMode.VmPolicy.Builder()
                .detectLeakedClosableObjects()
                .detectLeakedSqlLiteObjects()
                .detectActivityLeaks()
                .penaltyLog()
                .build(),
        )
    }
}
