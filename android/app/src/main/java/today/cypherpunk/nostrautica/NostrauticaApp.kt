package today.cypherpunk.nostrautica

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class NostrauticaApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.session.restore()
        // Relays are used only while the app is on screen: sockets close shortly
        // after it goes to the background, and nothing polls while it is there.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = container.nostr.onForeground()
            override fun onStop(owner: LifecycleOwner) = container.nostr.onBackground()
        })
    }
}
