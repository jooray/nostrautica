package today.cypherpunk.nostrautica.ui.screens.content

import androidx.compose.runtime.Composable
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.StubScreen

@Composable
fun PostsScreen(naddr: String) = StubScreen("title.posts", naddr)

@Composable
fun PostScreen(r: Route.Post) = StubScreen("title.post", r.naddr)

@Composable
fun TalksScreen(naddr: String) = StubScreen("title.talks", naddr)

@Composable
fun TalkScreen(r: Route.Talk) = StubScreen("title.talk", r.naddr)
