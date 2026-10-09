package today.cypherpunk.nostrautica.ui.screens.content

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.content.Content
import today.cypherpunk.nostrautica.domain.content.EventPost
import today.cypherpunk.nostrautica.domain.content.FeedSource
import today.cypherpunk.nostrautica.domain.content.FeedVisibility
import today.cypherpunk.nostrautica.domain.content.PostLogic
import today.cypherpunk.nostrautica.domain.content.TalkItem
import today.cypherpunk.nostrautica.domain.content.content
import today.cypherpunk.nostrautica.i18n.I18n
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.EmptyState
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.IconSquare
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.Notice
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/** A Page that can be pulled down to refresh (forcing past the TTL). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RefreshablePage(p: PaddingValues, refreshing: Boolean, onRefresh: () -> Unit, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    PullToRefreshBox(refreshing, onRefresh, Modifier.fillMaxSize().padding(top = p.calculateTopPadding())) {
        Page(PaddingValues(bottom = p.calculateBottomPadding()), content)
    }
}

/** `#/e/:naddr/posts` (Posts.svelte): the event's blog feed with source × visibility filters. */
@Composable
fun PostsScreen(naddr: String) = EventScaffold(naddr) { p ->
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val content = c.content
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val owner = account?.pubkey
    val keysVersion by c.eventKeys.changes.collectAsState()
    val official by remember(owner, ev.coordinate) { content.observePosts(owner, ev.coordinate, Content.Slot.EVENT) }.collectAsState(null)
    val external by remember(owner, ev.coordinate) { content.observePosts(owner, ev.coordinate, Content.Slot.EXTERNAL) }.collectAsState(null)
    val attendees by remember(owner, ev.coordinate) { content.observePosts(owner, ev.coordinate, Content.Slot.ATTENDEES) }.collectAsState(null)
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var source by rememberSaveable { mutableStateOf(FeedSource.BOTH) }
    var visibility by rememberSaveable { mutableStateOf(FeedVisibility.BOTH) }

    LaunchedEffect(ev.coordinate, owner, keysVersion) {
        runCatching { content.refresh(ev.ctx, owner) }
        loading = false
    }
    val all = (official ?: emptyList()) + (external ?: emptyList())
    val posts = remember(all, attendees, source, visibility) { PostLogic.filter(all, attendees ?: emptyList(), source, visibility) }
    val empty = official == null && external == null && attendees == null

    RefreshablePage(p, refreshing, {
        scope.launch { refreshing = true; runCatching { content.refresh(ev.ctx, owner, force = true) }; refreshing = false }
    }) {
        item { ScreenTitle(s.t("posts.title")) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Dim(s.t("posts.filter.source"), size = 13)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(FeedSource.BOTH to "posts.filter.both", FeedSource.EVENT to "posts.filter.source.event", FeedSource.ATTENDEES to "posts.filter.source.attendees")
                        .forEach { (v, k) -> SmallButton(s.t(k), { source = v }, selected = source == v) }
                }
                Dim(s.t("posts.filter.visibility"), size = 13)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(FeedVisibility.BOTH to "posts.filter.both", FeedVisibility.PUBLIC to "post.editor.public", FeedVisibility.MEMBERS to "post.editor.members")
                        .forEach { (v, k) -> SmallButton(s.t(k), { visibility = v }, selected = visibility == v) }
                }
            }
        }
        if (posts.any { it.newer }) item { Notice(s.t("content.updateNeeded")) }
        when {
            posts.isEmpty() && loading && empty -> item { Dim(s.t("posts.loading")) }
            posts.isEmpty() -> item { Dim(s.t("posts.none")) }
            else -> items(posts.size, key = { posts[it].key }) { i -> PostCard(posts[i], naddr) }
        }
    }
}

/** `#/e/:naddr/posts/:d` (Post.svelte): one post, a members-only one locked without the key. */
@Composable
fun PostScreen(r: Route.Post) = EventScaffold(r.naddr) { p ->
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val router = LocalRouter.current
    val content = c.content
    val account by c.session.account.collectAsState()
    val owner = account?.pubkey
    val keysVersion by c.eventKeys.changes.collectAsState()
    var loading by remember(r.d) { mutableStateOf(true) }
    val post by produceState<EventPost?>(null, r.d, owner, keysVersion) {
        content.cachedPostByD(owner, ev.coordinate, r.d)?.let { value = it }
        runCatching { content.postByD(ev.ctx, owner, r.d) }.getOrNull()?.let { value = it }
        loading = false
    }
    Page(p) {
        val shown = post
        when {
            shown == null && loading -> item { Dim(s.t("posts.loading")) }
            shown == null -> item {
                EmptyState(s.t("post.notFound"), s.t("post.notFound.body")) {
                    SmallButton(s.t("post.allPosts"), { router.go(Route.Posts(r.naddr)) })
                }
            }
            else -> {
                item { PostCard(shown, r.naddr, full = true, openable = false) }
                item { SmallButton(s.t("post.allPosts"), { router.go(Route.Posts(r.naddr)) }) }
            }
        }
    }
}

/** `#/e/:naddr/talks` (Talks.svelte): the event's published talks, members only. */
@Composable
fun TalksScreen(naddr: String) = EventScaffold(naddr) { p ->
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val content = c.content
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val owner = account?.pubkey
    val keysVersion by c.eventKeys.changes.collectAsState()
    val items by remember(owner, ev.coordinate) {
        if (owner == null) flowOf(emptyList()) else content.observeTalks(owner, ev.coordinate)
    }.collectAsState(null)
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var newer by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }

    suspend fun load(force: Boolean) {
        error = null
        val o = owner ?: run { loaded = true; return }
        runCatching { content.refreshTalks(ev.ctx, o, force) }
            .onSuccess { st -> loaded = true; newer = st?.newerSeen == true }
            .onFailure { e -> error = e.message ?: s.t("event.loadFailed") }
    }
    LaunchedEffect(ev.coordinate, owner, keysVersion, attempt) { load(force = attempt > 0) }

    val list = items ?: emptyList()
    val pubkeys = remember(list) { list.map { it.talk.pubkey }.distinct() }
    val profiles by remember(pubkeys) { c.profiles.observe(pubkeys) }.collectAsState(emptyMap())
    LaunchedEffect(pubkeys) { runCatching { c.profiles.refresh(pubkeys) } }

    RefreshablePage(p, refreshing, { scope.launch { refreshing = true; load(force = true); refreshing = false } }) {
        item { ScreenTitle(s.t("talks.title")) }
        if (ev.ctx.cfg.talks == "off") {
            item { Card { Dim(s.t("talks.disabled")) } }
            return@RefreshablePage
        }
        if (newer) item { Notice(s.t("content.updateNeeded")) }
        when {
            error != null && list.isEmpty() -> item { ErrorCard(s.t("event.loadFailed") + "\n" + error, { attempt++ }, s.t("error.state.retry")) }
            items == null || (!loaded && list.isEmpty()) -> item { Loading(s.t("app.loading")) }
            else -> {
                if (account != null) item { PrimaryButton(s.t("talks.submit"), { router.go(Route.Record(naddr, talk = true)) }) }
                if (list.isEmpty()) item { EmptyState(s.t("talks.empty.title"), s.t("talks.empty.body")) }
                else items(list.size, key = { list[it].d }) { i ->
                    val it = list[i]
                    val prof = profiles[it.talk.pubkey]
                    Card(onClick = { router.go(Route.Talk(naddr, it.d)) }) {
                        Row(verticalAlignment = Alignment.Top) {
                            Avatar(it.talk.pubkey, prof?.name, prof?.picture, 40.dp)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(it.talk.title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                                if (it.talk.description.isNotBlank()) Dim(it.talk.description, maxLines = 2)
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    talkBadges(it, s).forEach { b -> Pill(b, t.bgElev2, t.textDim) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Talks.svelte's card badges: kind (and length), external, transcript. */
private fun talkBadges(it: TalkItem, s: I18n.Strings): List<String> = buildList {
    fun t(k: String) = s.t(k)
    val m = it.talk.media
    if (m != null) add((if (m.kind == "talk") t("record.kind.talk") else t("record.kind.intro")) + (m.duration?.takeIf { d -> d > 0 }?.let { d -> " · ${Math.round(d)}s" } ?: ""))
    else if (it.talk.externalUrl != null) add(t("talks.mod.externalLabel"))
    if (it.talk.transcript != null) add(t("talks.hasTranscript"))
}

/** `#/e/:naddr/talks/:d` (TalkDetail.svelte): watch one talk, favorite it, resume, edit your own. */
@Composable
fun TalkScreen(r: Route.Talk) = EventScaffold(r.naddr) { p ->
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val router = LocalRouter.current
    val content = c.content
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val owner = account?.pubkey
    val keysVersion by c.eventKeys.changes.collectAsState()
    val talkItem by remember(owner, ev.coordinate, r.d) {
        if (owner == null) flowOf(null) else content.observeTalks(owner, ev.coordinate).map { l -> l?.firstOrNull { it.d == r.d } }
    }.collectAsState(null)
    val favorites by remember(owner, ev.coordinate) {
        if (owner == null) flowOf(emptyList()) else content.observeFavorites(owner, ev.coordinate)
    }.collectAsState(emptyList())
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(ev.coordinate, owner, keysVersion) {
        val o = owner
        if (o != null && ev.ctx.cfg.talks != "off") {
            runCatching { content.refreshTalks(ev.ctx, o) }.onFailure { e -> error = e.message }
        }
        loading = false
    }
    val talk = talkItem?.talk
    val speaker by remember(talk?.pubkey) { talk?.pubkey?.let { c.profiles.observe(listOf(it)) } ?: flowOf(emptyMap()) }.collectAsState(emptyMap())
    LaunchedEffect(talk?.pubkey) { talk?.pubkey?.let { runCatching { c.profiles.refresh(listOf(it)) } } }
    val mediaX = talk?.media?.x
    val resumeAt by produceState(-1L, mediaX, owner) {
        value = if (mediaX != null && owner != null) content.watchProgress(owner, ev.coordinate, mediaX) else 0L
    }

    Page(p) {
        item { LinkButton(s.t("talks.back"), { router.switchTo(Route.Talks(r.naddr)) }) }
        if (error != null && talk == null) item { ErrorCard(s.t("event.loadFailed") + "\n" + error) }
        when {
            talk == null && loading -> item { Loading(s.t("app.loading")) }
            talk == null -> item { Card { Dim(s.t("talks.notFound")) } }
            else -> item {
                val fav = r.d in favorites
                val prof = speaker[talk.pubkey]
                Card {
                    Row(verticalAlignment = Alignment.Top) {
                        Text(talk.title, Modifier.weight(1f), style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
                        if (owner != null) IconSquare(
                            if (fav) Icons.Outlined.Bookmark else Icons.Outlined.BookmarkBorder,
                            if (fav) s.t("talks.favorite.remove") else s.t("talks.favorite.add"),
                            { scope.launch { content.toggleFavorite(owner, ev.coordinate, r.d) } },
                            highlighted = fav,
                        )
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(talk.pubkey, prof?.name, prof?.picture, 32.dp)
                        Spacer(Modifier.width(8.dp))
                        Dim(prof?.name ?: s.t("talks.speaker"), maxLines = 1)
                    }
                    if (resumeAt > 0) Dim(s.t("talks.resuming", "sec" to resumeAt), size = 13)
                    val media = talk.media
                    val ext = talk.externalUrl
                    when {
                        media != null && resumeAt >= 0 -> EncryptedMediaPlayer(media, talk.transcript, resumeAt) { sec ->
                            if (owner != null) content.saveWatchProgress(owner, ev.coordinate, media.x, sec)
                        }
                        ext != null && talk.externalKind != null -> ExternalTalkPlayer(ext, talk.externalKind!!)
                    }
                    if (talk.description.isNotBlank()) Text(talk.description, fontSize = 16.sp, lineHeight = 23.sp, overflow = TextOverflow.Clip)
                    if (owner == talk.pubkey) SecondaryButton(s.t("talks.edit"), { router.go(Route.Record(r.naddr, talk = true, editTalk = r.d)) })
                }
            }
        }
    }
}
