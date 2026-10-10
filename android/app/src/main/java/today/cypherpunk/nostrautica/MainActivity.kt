package today.cypherpunk.nostrautica

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.ComponentActivity
import kotlinx.coroutines.flow.MutableStateFlow
import today.cypherpunk.nostrautica.ui.AppRoot
import today.cypherpunk.nostrautica.ui.nav.Route

class MainActivity : ComponentActivity() {
    /** Links that opened (or re-opened) the app, consumed by the root composable. */
    val incoming = MutableStateFlow<Pair<Route, String?>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val container = (application as NostrauticaApp).container
        handle(intent)
        setContent { AppRoot(container, incoming) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        Route.fromUri(data)?.let { incoming.value = it }
    }
}
