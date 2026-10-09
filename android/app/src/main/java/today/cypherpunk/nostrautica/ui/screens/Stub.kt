package today.cypherpunk.nostrautica.ui.screens

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.GlobalScaffold
import today.cypherpunk.nostrautica.ui.shell.Page

/** Placeholder for a screen that hasn't been built yet. */
@Composable
fun StubScreen(titleKey: String, naddr: String? = null) {
    val s = LocalStrings.current
    val body: @Composable (androidx.compose.foundation.layout.PaddingValues) -> Unit = { p ->
        Page(p) { item { ScreenTitle(s.t(titleKey)) }; item { Loading() } }
    }
    if (naddr != null) EventScaffold(naddr) { body(it) } else GlobalScaffold { body(it) }
}
