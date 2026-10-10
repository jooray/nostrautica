package today.cypherpunk.nostrautica.ui.screens.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.NewerProtocolSeen
import today.cypherpunk.nostrautica.domain.people.Band
import today.cypherpunk.nostrautica.domain.people.Confidence
import today.cypherpunk.nostrautica.domain.people.Directory
import today.cypherpunk.nostrautica.domain.people.EmptyReason
import today.cypherpunk.nostrautica.domain.people.Featured
import today.cypherpunk.nostrautica.domain.people.IntroRules
import today.cypherpunk.nostrautica.domain.people.PeopleNames
import today.cypherpunk.nostrautica.domain.people.RosterState
import today.cypherpunk.nostrautica.domain.people.Search
import today.cypherpunk.nostrautica.domain.people.SettingList
import today.cypherpunk.nostrautica.domain.people.SettingsRules
import today.cypherpunk.nostrautica.domain.people.Watermark
import today.cypherpunk.nostrautica.domain.people.WhatsNewRules
import today.cypherpunk.nostrautica.domain.people.eventSettings
import today.cypherpunk.nostrautica.domain.dm.dms
import today.cypherpunk.nostrautica.domain.people.observeMany
import today.cypherpunk.nostrautica.domain.people.peopleSocial
import today.cypherpunk.nostrautica.domain.people.undecryptableEntries
import today.cypherpunk.nostrautica.domain.people.whatsNew
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.Match
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.DisplayFont
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.Collator
import java.util.Locale

/** The People filter chips (favorites retired: want to meet, met, following). */
private enum class PeopleFilter(val key: String) {
    WANT_TO_MEET("attendees.filter.wantToMeet"), MET("attendees.filter.met"), FOLLOWING("attendees.filter.following")
}

/** One rendered row of the list, so a banner name can scroll to its person by index. */
private sealed interface PRow {
    val key: String
    data object Title : PRow { override val key = "title" }
    data class Error(val text: String) : PRow { override val key = "error" }
    data object Decrypting : PRow { override val key = "decrypting" }
    data class Empty(val reason: EmptyReason) : PRow { override val key = "empty" }
    data object SearchBox : PRow { override val key = "search" }
    data class Stale(val text: String) : PRow { override val key = "stale" }
    data class Returned(val n: Int, val newcomers: List<String>) : PRow { override val key = "returned" }
    data object NoStrong : PRow { override val key = "nostrong" }
    data class BandHead(val band: Band, val n: Int) : PRow { override val key = "band:$band" }
    data class MatchItem(val m: Match) : PRow { override val key = "m:${m.pubkey}" }
    data object Awaiting : PRow { override val key = "awaiting" }
    data class DirHead(val everyone: Boolean, val count: String) : PRow { override val key = "dirhead" }
    data object Filters : PRow { override val key = "filters" }
    data object NoRows : PRow { override val key = "norows" }
    data class Person(val e: DirectoryEntryContent, val first: Boolean, val last: Boolean) : PRow { override val key = "p:${e.pubkey}" }
}

/**
 * pages/Attendees.svelte — People: the merged roster + matches list.
 *
 * Matched people lead in band order with their FULL reasoning (measured: 168
 * chars median, four phone lines; the reasoning was never what made the list
 * long). Everyone else follows by name, collated in the active locale. Searching
 * or filtering dissolves the sections into one ranked list. "Worth a hello"
 * folds into the directory as a tagged row, except for the attendee with nothing
 * better, whose best band is promoted with a plain "nothing sharp yet" line.
 *
 * Cache-first: the roster, matches, profiles, follows and private settings paint
 * from the phone; one refresh pass runs per open (TTL-bounded), and the list says
 * how old it is when no relay has confirmed it.
 */
@Composable
fun AttendeesBody(padding: PaddingValues) {
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val me = account?.pubkey
    val owner = me ?: Cache.ANON
    val coord = ev.coordinate
    val naddr = ev.naddr

    // ── Cache-first state ──
    val entriesOrNull by remember(owner, coord) { c.members.observeDirectory(owner, coord) }.collectAsState(null)
    val entries = entriesOrNull ?: emptyList()
    val matchList by remember(owner, coord) { c.members.observeMatches(owner, coord) }.collectAsState(null)
    val pubkeys = remember(entries) { entries.map { it.pubkey } }
    val profiles by remember(pubkeys) { c.profiles.observeMany(pubkeys) }.collectAsState(emptyMap())
    val followList by remember(me) { me?.let { c.peopleSocial.observeFollowList(it) } ?: flowOf(null) }.collectAsState(null)
    var followsFetched by remember { mutableStateOf(false) }
    val followsKnown = followList != null || followsFetched
    val followSet = remember(followList) { followList?.tags?.filter { it.size >= 2 && it[0] == "p" }?.map { it[1] }?.toSet() ?: emptySet() }
    val settings by remember(owner, coord) { c.eventSettings.observe(owner, coord) }.collectAsState(null)
    val muted by c.dms.mutes.muted.collectAsState()

    var query by rememberSaveable { mutableStateOf("") }
    var filters by remember { mutableStateOf(emptySet<PeopleFilter>()) }
    var reload by remember { mutableIntStateOf(0) }
    var running by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var hasKey by remember { mutableStateOf(true) }
    var undecryptable by remember { mutableIntStateOf(0) }
    var onlineAtSettle by remember { mutableStateOf(true) }
    var relayAtSettle by remember { mutableStateOf(true) }
    var confirmed by remember { mutableStateOf(false) }
    var settled by remember { mutableStateOf(false) }
    var lastReadAt by remember { mutableStateOf<Long?>(null) }
    var priorSeen by remember { mutableStateOf<Watermark?>(null) }
    var newPubkeys by remember { mutableStateOf(emptySet<String>()) }
    var flash by remember { mutableStateOf<String?>(null) }

    // The watermark as it stood BEFORE this visit: marking the list seen is the next thing that happens.
    LaunchedEffect(owner, coord) {
        lastReadAt = c.peopleSocial.rosterReadAt(owner, coord)
        priorSeen = c.whatsNew.load(owner, coord)
    }
    // A hung pass must not suppress the stale cue forever, nor a healthy one flash it.
    LaunchedEffect(Unit) { delay(3_000); settled = true }

    // Mark what is on screen as seen; remember who was new before we did.
    LaunchedEffect(priorSeen, entriesOrNull, matchList) {
        val seen = priorSeen ?: return@LaunchedEffect
        if (entriesOrNull == null) return@LaunchedEffect
        val matchPks = matchList?.matches?.map { it.pubkey }
        val fresh = WhatsNewRules.newSince(matchPks, pubkeys, seen.copy(seenApproved = false, at = 0))
        if (fresh.any { it !in newPubkeys }) newPubkeys = newPubkeys + fresh
        if (!matchPks.isNullOrEmpty()) c.whatsNew.markMatchesSeen(owner, coord, matchPks)
        if (pubkeys.isNotEmpty()) c.whatsNew.markRosterSeen(owner, coord, pubkeys)
    }

    // One refresh pass per open (and per retry): roster → directory → matches,
    // with follows, private settings and mutes alongside. Nothing here blocks the paint.
    LaunchedEffect(me, reload) {
        running = true
        error = null
        val force = reload > 0
        val a = account
        hasKey = a != null && c.eventKeys.get(a.pubkey, coord)?.current != null
        var refreshed = false
        if (a != null) coroutineScope {
            launch { runCatching { c.dms.mutes.refresh(a.signer, fetch = true) } }
            launch { if (runCatching { c.peopleSocial.refreshFollows(a.pubkey, force) }.getOrDefault(false)) followsFetched = true }
            launch { runCatching { c.eventSettings.load(ev.ctx, force = force) } }
            launch {
                runCatching { c.members.refresh(ev.ctx, a.signer, force) }
                    .onSuccess { refreshed = it }
                    .onFailure { e ->
                        if (c.members.cachedDirectory(a.pubkey, coord).isEmpty())
                            error = if (e is NewerProtocolSeen) s.t("update.available") else e.message ?: e.toString()
                    }
                val dir = c.members.cachedDirectory(a.pubkey, coord)
                if (dir.isNotEmpty()) runCatching { c.profiles.refresh(dir.map { it.pubkey }) }
                undecryptable = if (dir.isEmpty() && hasKey) runCatching { c.members.undecryptableEntries(c.nostr, ev.ctx, a.pubkey) }.getOrDefault(0) else 0
            }
        }
        onlineAtSettle = c.nostr.network.value
        relayAtSettle = c.nostr.pool.online.value
        if (error == null && refreshed && hasKey && onlineAtSettle && relayAtSettle) {
            confirmed = true
            val now = System.currentTimeMillis()
            lastReadAt = now
            c.peopleSocial.markRosterRead(owner, coord, now)
        }
        running = false
        settled = true
    }

    // ── Derived ──
    val loading = entries.isEmpty() && (entriesOrNull == null || running)
    val entryBy = remember(entries) { entries.associateBy { it.pubkey } }
    val names = remember(entries, profiles) {
        entries.associate { it.pubkey to PeopleNames.nameOf(it.pubkey, profiles[it.pubkey], it, it.profile.about) }
    }
    fun nameOf(pk: String) = PeopleNames.nameOf(pk, profiles[pk], entryBy[pk])
    fun bioOf(pk: String) = PeopleNames.bioOf(entryBy[pk], profiles[pk], s.locale)

    val ranked = remember(matchList) { (matchList?.matches ?: emptyList()).sortedWith(Confidence.byMatchRank) }
    val visibleMatches = remember(ranked, muted) { ranked.filter { it.pubkey !in muted } }
    val matchBy = remember(ranked) { ranked.associateBy { it.pubkey } }
    // From the full ranked list: muting three people must not promote the next three.
    val strongCut = remember(ranked) { Confidence.strongCutFor(ranked) }
    val bandOf = { m: Match -> Confidence.bandAtCut(m.score, strongCut) }
    val featured = remember(visibleMatches, strongCut) { Featured.sections(visibleMatches, bandOf) }
    val featuredPks = remember(featured) { featured.flatMap { f -> f.items.map { it.pubkey } }.toSet() }
    val matchingOn = ev.ctx.cfg.coordinator != null
    val noStrong = Featured.noStrong(matchingOn, visibleMatches, bandOf)
    val ownEntry = me?.let { entryBy[it] }
    val needsIntro = ownEntry != null && !IntroRules.hasIntro(ownEntry)
    val introduced = remember(entries) { entries.count { it.aiProfile != null } }
    val awaitingMatches = matchingOn && hasKey && !loading && entries.isNotEmpty() && visibleMatches.isEmpty()

    val hasFilters = query.isNotBlank() || filters.isNotEmpty()
    val collator = remember(s.locale) { Collator.getInstance(Locale.forLanguageTag(s.locale)) }
    val byName = remember(entries, names, muted, collator) {
        entries.filter { it.pubkey !in muted }.sortedWith { a, b -> collator.compare(names[a.pubkey], names[b.pubkey]) }
    }
    fun passes(pk: String): Boolean = filters.all { f ->
        when (f) {
            PeopleFilter.FOLLOWING -> pk in followSet
            PeopleFilter.WANT_TO_MEET -> SettingsRules.has(settings, SettingList.WANT_TO_MEET, pk)
            PeopleFilter.MET -> SettingsRules.has(settings, SettingList.MET, pk)
        }
    }
    val visible = remember(byName, query, filters, featuredPks, newPubkeys, settings, followSet, s.locale) {
        Directory.rows(byName, query, hasFilters, ::passes, featuredPks, newPubkeys) { e -> Search.fields(e, names[e.pubkey] ?: "", s.locale) }
    }
    val newcomers = (featured.flatMap { f -> f.items.map { it.pubkey } } + visible.map { it.pubkey }).filter { it in newPubkeys }

    val stale = RosterState.staleCue(entries.size, settled, confirmed, lastReadAt)
    val emptyReason = RosterState.emptyReason(loading, hasKey, undecryptable, onlineAtSettle, relayAtSettle)

    // ── Actions ──
    fun open(pk: String) = router.go(Route.Attendee(naddr, Nip19.npub(pk)))
    fun message(pk: String) {
        if (account == null) { router.go(Route.Login()); return }
        // A match opens the composer on the coordinator's suggested opening line.
        val m = matchBy[pk]
        val suggestion = m?.icebreakers?.firstOrNull { it.isNotBlank() } ?: m?.reasoning?.takeIf { it.isNotBlank() }
        if (suggestion != null) c.dms.stagePrefill(pk, suggestion)
        router.go(Route.DmPeer(Nip19.npub(pk)))
    }
    fun toggleWant(pk: String) {
        if (account == null || !hasKey) return
        PeopleWrites.launch {
            runCatching { c.eventSettings.toggle(ev.ctx, SettingList.WANT_TO_MEET, pk) }
                .onSuccess { (_, r) -> if (r is Nostr.PublishResult.Queued) Toasts.show(s.t("sync.queued")) }
                .onFailure { e -> Toasts.show(e.message ?: e.toString()) }
        }
    }
    val canAct = { pk: String -> account != null && pk != me }

    // ── Rows ──
    val rows = buildList {
        add(PRow.Title)
        val err = error
        when {
            err != null -> add(PRow.Error(err))
            loading -> add(PRow.Decrypting)
            entries.isEmpty() -> add(PRow.Empty(emptyReason))
            else -> {
                add(PRow.SearchBox)
                if (stale.show) add(PRow.Stale(stale.at?.let { s.t("attendees.asOf", "time" to RosterState.formatAsOf(it, System.currentTimeMillis(), s.locale)) } ?: s.t("attendees.asOf.unknown")))
                if (!hasFilters) {
                    if (newPubkeys.isNotEmpty() && ev.isCommunity) add(PRow.Returned(newPubkeys.size, newcomers))
                    if (noStrong) add(PRow.NoStrong)
                    for (sec in featured) {
                        add(PRow.BandHead(sec.band, sec.items.size))
                        sec.items.forEach { add(PRow.MatchItem(it)) }
                    }
                    if (awaitingMatches) add(PRow.Awaiting)
                }
                add(PRow.DirHead(
                    featured.isNotEmpty() && !hasFilters,
                    if (hasFilters) s.tcp("attendees.showing", ev.isCommunity, visible.size) else s.tcp("attendees.count", ev.isCommunity, entries.size),
                ))
                if (account != null) add(PRow.Filters)
                if (visible.isEmpty()) add(PRow.NoRows)
                else visible.forEachIndexed { i, e -> add(PRow.Person(e, i == 0, i == visible.size - 1)) }
            }
        }
    }
    val listState = rememberLazyListState()
    fun jumpTo(pk: String) {
        val idx = rows.indexOfFirst { (it is PRow.Person && it.e.pubkey == pk) || (it is PRow.MatchItem && it.m.pubkey == pk) }
        if (idx < 0) return
        scope.launch {
            listState.animateScrollToItem(idx, -200)
            flash = pk
            delay(2_000)
            if (flash == pk) flash = null
        }
    }

    @Composable
    fun actionsFor(pk: String, name: String) {
        if (!canAct(pk)) return
        PersonActions(
            pk, name, followsKnown, pk in followSet, { /* the kind-3 observer repaints */ },
            SettingsRules.has(settings, SettingList.WANT_TO_MEET, pk), { toggleWant(pk) }, { message(pk) },
        )
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        state = listState,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding() + 16.dp, bottom = padding.calculateBottomPadding() + 24.dp),
    ) {
        items(rows, key = { it.key }) { row ->
            when (row) {
                PRow.Title -> ScreenTitle(s.t("attendees.title"))
                is PRow.Error -> Box(Modifier.padding(top = 14.dp)) { ErrorCard(row.text, { reload++ }, s.t("error.state.retry")) }
                PRow.Decrypting -> Box(Modifier.padding(top = 14.dp)) { Loading(s.t("attendees.decrypting")) }
                is PRow.Empty -> Box(Modifier.padding(top = 14.dp)) { EmptyCard(row.reason, ev.isCommunity, { reload++ }, { router.switchTo(Route.Event(naddr)) }) }
                PRow.SearchBox -> Box(Modifier.padding(top = 14.dp)) {
                    Field(query, { query = it }, s.t("attendees.search.label"), placeholder = s.t("attendees.search.placeholder"))
                }
                is PRow.Stale -> Dim(row.text, Modifier.padding(top = 8.dp), size = 13)
                is PRow.Returned -> ReturnedBanner(row.n, row.newcomers, { pk -> nameOf(pk) }, { pk -> profiles[pk]?.picture }, ::jumpTo)
                PRow.NoStrong -> Dim(s.t("matches.noStrong"), Modifier.padding(top = 10.dp), size = 14)
                is PRow.BandHead -> Column(Modifier.padding(top = 22.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ConfidenceBadge(row.band, small = true, section = true)
                        Spacer(Modifier.width(8.dp))
                        Text(row.n.toString(), color = t.textDim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                    HorizontalDivider(Modifier.padding(top = 8.dp), color = t.border)
                }
                is PRow.MatchItem -> {
                    val pk = row.m.pubkey
                    val name = nameOf(pk)
                    Column {
                        MatchEntry(row.m, name, bioOf(pk), profiles[pk]?.picture, pk in newPubkeys, flash == pk, { open(pk) }) { actionsFor(pk, name) }
                        HorizontalDivider(color = t.border)
                    }
                }
                PRow.Awaiting -> Box(Modifier.padding(top = 14.dp)) {
                    Card {
                        if (needsIntro) {
                            Dim(s.t("matches.none.noIntro"))
                            PrimaryButton(s.t("readiness.cta.record"), { router.go(Route.Record(naddr)) })
                        } else {
                            if (ev.isCommunity) Dim(s.t("matches.none.community", "n" to introduced))
                            else { Dim(s.t("matches.none")); Dim(s.t("matches.none.why")) }
                            SecondaryButton(if (running) s.t("error.state.retrying") else s.t("matches.checkAgain"), { reload++ }, enabled = !running)
                        }
                    }
                }
                is PRow.DirHead -> Row(Modifier.fillMaxWidth().padding(top = 22.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (row.everyone) Text(s.t("attendees.section.everyone"), Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    else Spacer(Modifier.weight(1f))
                    Dim(row.count, size = 13)
                }
                PRow.Filters -> FilterRow(filters, { f -> filters = if (f in filters) filters - f else filters + f }, hasFilters) { query = ""; filters = emptySet() }
                PRow.NoRows -> Box(Modifier.padding(top = 10.dp)) {
                    Card {
                        Dim(if (hasFilters) s.t("attendees.noResults") else s.t("attendees.section.allFeatured"))
                        if (hasFilters) SmallButton(s.t("attendees.filter.clear"), { query = ""; filters = emptySet() })
                    }
                }
                is PRow.Person -> {
                    val e = row.e
                    val pk = e.pubkey
                    val name = names[pk] ?: nameOf(pk)
                    val shape = RoundedCornerShape(
                        topStart = if (row.first) 14.dp else 0.dp, topEnd = if (row.first) 14.dp else 0.dp,
                        bottomStart = if (row.last) 14.dp else 0.dp, bottomEnd = if (row.last) 14.dp else 0.dp,
                    )
                    Column(Modifier.padding(top = if (row.first) 10.dp else 0.dp).clip(shape).background(t.bgElev).padding(horizontal = 10.dp)) {
                        PersonRow(
                            pk, name, bioOf(pk) ?: e.aiProfile?.summary?.takeIf { it.isNotBlank() }, profiles[pk]?.picture,
                            pk in newPubkeys, flash == pk, { open(pk) },
                            trailing = if (pk in matchBy) ({ Chip(s.t("attendees.matchTag"), accent = true) }) else null,
                            actions = if (canAct(pk)) ({ actionsFor(pk, name) }) else null,
                        )
                        if (!row.last) HorizontalDivider(color = t.border)
                    }
                }
            }
        }
    }
}

/** Three different facts, three different cards; only the fixable one offers a retry. */
@Composable
private fun EmptyCard(reason: EmptyReason, community: Boolean, retry: () -> Unit, back: () -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val text = when (reason) {
        EmptyReason.UNREACHABLE -> s.t("attendees.empty.unreachable")
        EmptyReason.STALE_KEY -> s.t("attendees.empty.staleKey")
        EmptyReason.NOT_APPROVED -> s.t("attendees.empty.notApproved")
        else -> s.tc("attendees.empty.none", community)
    }
    val body: @Composable () -> Unit = {
        Dim(text)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (reason != EmptyReason.NOT_APPROVED) SmallButton(s.t("error.state.retry"), retry)
            SmallButton(s.t("attendees.backToEvent"), back)
        }
    }
    if (reason == EmptyReason.UNREACHABLE) SoftCard(color = t.warnSoft) { body() } else Card { body() }
}

/** A community's return signal: who arrived since the last visit, each name a jump. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReturnedBanner(n: Int, newcomers: List<String>, nameOf: (String) -> String, pictureOf: (String) -> String?, jump: (String) -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(s.tp("attendees.sinceLastVisit", n), fontFamily = DisplayFont, fontSize = 17.sp, lineHeight = 25.sp)
        if (newcomers.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            newcomers.take(NEWCOMERS_NAMED).forEach { pk ->
                val name = nameOf(pk)
                Row(
                    Modifier.clip(RoundedCornerShape(999.dp)).border(1.dp, t.border, RoundedCornerShape(999.dp)).background(t.bgElev)
                        .clickable { jump(pk) }.padding(start = 3.dp, end = 11.dp, top = 3.dp, bottom = 3.dp).widthIn(max = 220.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(pk, name, pictureOf(pk), 22.dp)
                    Spacer(Modifier.width(6.dp))
                    Text(name, fontWeight = FontWeight.SemiBold, fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (newcomers.size > NEWCOMERS_NAMED) Dim(s.t("attendees.newcomersMore", "n" to (newcomers.size - NEWCOMERS_NAMED)), Modifier.padding(top = 4.dp), size = 13)
        }
    }
}

private const val NEWCOMERS_NAMED = 3

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterRow(active: Set<PeopleFilter>, toggle: (PeopleFilter) -> Unit, hasFilters: Boolean, clear: () -> Unit) {
    val s = LocalStrings.current
    FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PeopleFilter.entries.forEach { f -> SmallButton(s.t(f.key), { toggle(f) }, selected = f in active) }
        if (hasFilters) SmallButton(s.t("attendees.filter.clear"), clear)
    }
}
