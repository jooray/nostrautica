package today.cypherpunk.nostrautica.ui.screens.people

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.data.Cache
import today.cypherpunk.nostrautica.domain.people.Confidence
import today.cypherpunk.nostrautica.domain.people.PeopleNames
import today.cypherpunk.nostrautica.domain.people.SettingList
import today.cypherpunk.nostrautica.domain.people.SettingsRules
import today.cypherpunk.nostrautica.domain.dm.MuteListOffline
import today.cypherpunk.nostrautica.domain.dm.UnreadableMuteList
import today.cypherpunk.nostrautica.domain.dm.dms
import today.cypherpunk.nostrautica.ui.screens.content.EncryptedMediaPlayer
import today.cypherpunk.nostrautica.ui.screens.content.NoteView
import today.cypherpunk.nostrautica.domain.people.eventSettings
import today.cypherpunk.nostrautica.domain.people.observeMany
import today.cypherpunk.nostrautica.domain.people.peopleSocial
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.nostr.Nostr
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.PerEventSettings
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Body
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.DisplayFont
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

private enum class NoteState { IDLE, SAVING, SAVED }

/**
 * pages/Attendee.svelte — one person: who they are (live kind-0 name first, the
 * event bio and their current Nostr bio side by side when they differ), their
 * intro (text, or the encrypted recording with its transcript), the coordinator's
 * summary, follow / message / mute, why the two of you match with "Introduce
 * us", private want-to-meet / met / note, and their recent public notes.
 *
 * Paints from the phone first; each slice refreshes on its own and none blocks
 * the others.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AttendeeBody(padding: PaddingValues, npub: String) {
    val ev = LocalEvent.current
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val me = account?.pubkey
    val owner = me ?: Cache.ANON
    val coord = ev.coordinate
    // A malformed link renders an error, never an interactive empty profile whose
    // Follow would publish ["p", ""] (audit UX-23).
    val pubkey = remember(npub) { runCatching { Nip19.decodeNpub(npub) }.getOrNull() }
    if (pubkey == null) {
        Page(padding) {
            item {
                SoftCard(color = t.warnSoft) {
                    Text(s.t("attendee.error.badNpub"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("attendee.error.badNpub.body"))
                }
            }
        }
        return
    }

    val profile by remember(pubkey) { c.profiles.observeMany(listOf(pubkey)).map { it[pubkey] } }.collectAsState(null)
    val entry by remember(owner, coord, pubkey) { c.members.observeDirectory(owner, coord).map { l -> l.firstOrNull { it.pubkey == pubkey } } }.collectAsState(null)
    val matchList by remember(owner, coord) { c.members.observeMatches(owner, coord) }.collectAsState(null)
    val followList by remember(me) { me?.let { c.peopleSocial.observeFollowList(it) } ?: flowOf(null) }.collectAsState(null)
    val posts by remember(pubkey) { c.peopleSocial.observeRecentPosts(pubkey) }.collectAsState(emptyList())
    val observedSettings by remember(owner, coord) { c.eventSettings.observe(owner, coord) }.collectAsState(null)
    var loadedSettings by remember { mutableStateOf<PerEventSettings?>(null) }
    val settings = observedSettings ?: loadedSettings
    val mutedSet by c.dms.mutes.muted.collectAsState()
    val muteUnreadable by c.dms.mutes.unreadable.collectAsState()

    var followKnown by remember { mutableStateOf(false) }
    var followsYou by remember { mutableStateOf(false) }
    var profileDone by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var confirmMute by remember { mutableStateOf(false) }
    var showAnyway by remember { mutableStateOf(false) }
    var showTranslated by remember { mutableStateOf(true) }
    var copied by remember { mutableStateOf<String?>(null) }
    var noteDraft by remember { mutableStateOf("") }
    var noteTouched by remember { mutableStateOf(false) }
    var noteState by remember { mutableStateOf(NoteState.IDLE) }

    val following = followList?.tags?.any { it.size >= 2 && it[0] == "p" && it[1] == pubkey } == true
    val muted = pubkey in mutedSet
    val myMatch = matchList?.matches?.firstOrNull { it.pubkey == pubkey }
    val strongCut = matchList?.matches?.let(Confidence::strongCutFor) ?: Confidence.STRONG_FLOOR

    // Paint the cached note; never over something the user is typing.
    LaunchedEffect(settings) { if (!noteTouched) noteDraft = settings?.notes?.get(pubkey) ?: "" }

    LaunchedEffect(pubkey, me) {
        val a = account
        coroutineScope {
            launch {
                val k = "k0detail:$pubkey"
                runCatching { c.profiles.refresh(listOf(pubkey), force = !c.cache.isFresh(k, 10 * 60_000L)) }
                c.cache.markFetched(k)
                profileDone = true
            }
            launch { runCatching { c.peopleSocial.refreshRecentPosts(pubkey) } }
            if (a == null) { followKnown = true; return@coroutineScope }
            if (ev.isMember) launch { runCatching { c.members.refresh(ev.ctx, a.signer) } }
            launch { runCatching { c.dms.mutes.refresh(a.signer, fetch = true) } }
            launch {
                runCatching { c.peopleSocial.refreshFollows(a.pubkey) }
                // Even on a timeout: the empty-list guard surfaces a real failure on tap.
                followKnown = true
                followsYou = runCatching { c.peopleSocial.followsYou(a.pubkey, pubkey) }.getOrDefault(false)
            }
            launch { runCatching { c.eventSettings.load(ev.ctx) }.onSuccess { loadedSettings = it } }
        }
        followKnown = true
    }

    var notePending by remember { mutableStateOf(false) }
    fun saveNote(draft: String) {
        if (account == null) return
        notePending = false
        PeopleWrites.launch {
            runCatching { c.eventSettings.setNote(ev.ctx, pubkey, draft) }
                .onSuccess { (st, r) ->
                    loadedSettings = st
                    noteState = NoteState.SAVED
                    if (r is Nostr.PublishResult.Queued) Toasts.show(s.t("sync.queued"))
                    delay(2_000)
                    if (noteState == NoteState.SAVED) noteState = NoteState.IDLE
                }
                .onFailure { e -> noteState = NoteState.IDLE; error = e.message ?: e.toString() }
        }
    }
    // Save as you type (debounced); leaving mid-debounce still saves.
    LaunchedEffect(noteDraft, noteTouched) {
        if (!noteTouched) return@LaunchedEffect
        noteState = NoteState.SAVING
        notePending = true
        delay(800)
        saveNote(noteDraft)
    }
    // Leaving mid-debounce still saves (the PWA lost these on navigation).
    DisposableEffect(Unit) {
        onDispose { if (notePending) saveNote(noteDraft) }
    }

    fun toggle(list: SettingList) {
        if (account == null) return
        PeopleWrites.launch {
            runCatching { c.eventSettings.toggle(ev.ctx, list, pubkey) }
                .onSuccess { (st, r) -> loadedSettings = st; if (r is Nostr.PublishResult.Queued) Toasts.show(s.t("sync.queued")) }
                .onFailure { e -> error = e.message ?: e.toString() }
        }
    }
    fun toggleMute() {
        val a = account ?: run { router.go(Route.Login()); return }
        busy = true
        error = null
        PeopleWrites.launch {
            runCatching { c.dms.mutes.toggle(a.signer, pubkey) }
                .onSuccess { confirmMute = false; showAnyway = false }
                .onFailure { e ->
                    error = when {
                        e is UnreadableMuteList || muteUnreadable -> s.t("mute.unreadable")
                        e is MuteListOffline -> s.t("error.cat.offline")
                        else -> e.message ?: e.toString()
                    }
                }
            busy = false
        }
    }
    fun introduce() {
        if (account == null) { router.go(Route.Login()); return }
        val suggestion = myMatch?.icebreakers?.firstOrNull { it.isNotBlank() } ?: myMatch?.reasoning?.takeIf { it.isNotBlank() }
        if (suggestion != null) c.dms.stagePrefill(pubkey, suggestion)
        router.go(Route.DmPeer(npub))
    }
    val nprofile = remember(pubkey, ev.ctx.cfg) { Nip19.nprofile(Nip19.Profile(pubkey, ev.ctx.cfg.relays.take(3))) }
    fun copy(which: String) {
        val value = if (which == "npub") npub else nprofile
        ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(which, value))
        copied = which
        scope.launch { delay(1_500); if (copied == which) copied = null }
    }

    val e = entry
    val kind0 = profile?.raw
    val loading = profile == null && e == null && !profileDone
    val displayName = PeopleNames.attendeeDisplayName(kind0, e, s.t("attendee.name"))
    val translation = e?.let { PeopleNames.translation(it, s.locale) }
    val useTranslated = translation != null && showTranslated
    val aboutText = (if (useTranslated) translation.about?.takeIf { it.isNotEmpty() } else null)
        ?: e?.profile?.about?.takeIf { it.isNotEmpty() } ?: profile?.about ?: ""
    val nostrAbout = PeopleNames.nostrAbout(profile?.about, aboutText)
    val lookingFor = (if (useTranslated) translation.lookingFor?.takeIf { it.isNotEmpty() } else null) ?: e?.profile?.lookingFor.orEmpty()
    val skills = (if (useTranslated && !translation.skills.isNullOrEmpty()) translation.skills else e?.profile?.skills) ?: emptyList()
    val ai = e?.aiProfile
    val aiFields = listOf(
        "skills" to (ai?.skills ?: emptyList()).filter { it !in skills },
        "interests" to (ai?.interests ?: emptyList()),
        "offers" to (ai?.offers ?: emptyList()),
        "seeks" to (ai?.seeks ?: emptyList()),
    )

    Page(padding) {
        error?.let { msg -> item { ErrorCard(msg, { error = null }, s.t("attendee.mute.cancel")) } }
        when {
            loading -> item { SkeletonCard() }
            muted && !showAnyway -> item {
                Card {
                    Text(s.t("attendee.muted.title"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("mute.confirm"))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(s.t("attendee.unmute"), { toggleMute() }, Modifier.weight(1f), busy = busy)
                        SecondaryButton(s.t("attendee.showAnyway"), { showAnyway = true }, Modifier.weight(1f))
                    }
                }
            }
            else -> {
                item {
                    Card {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(pubkey, displayName, profile?.picture, 56.dp)
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(displayName, fontFamily = DisplayFont, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 30.sp)
                                if (following || followsYou) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    if (following) Chip(s.t("attendee.youFollow"))
                                    if (followsYou) Chip(s.t("attendee.followsYou"))
                                }
                            }
                        }
                        if (translation != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (useTranslated) Chip(s.t("attendee.translated"))
                            Text(
                                if (useTranslated) s.t("attendee.showOriginal") else s.t("attendee.showTranslation"),
                                Modifier.clickable { showTranslated = !showTranslated }.padding(vertical = 4.dp),
                                color = t.accent, fontSize = 14.sp,
                            )
                        }
                        if (aboutText.isNotEmpty()) Body(aboutText)
                        if (nostrAbout.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(s.t("attendee.nostrAbout"), color = t.textDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            Dim(nostrAbout)
                        }
                        e?.introText?.takeIf { it.isNotBlank() }?.let { intro ->
                            SoftCard(color = t.bgElev2) {
                                Text(s.t("attendee.textIntro"), fontWeight = FontWeight.SemiBold)
                                Text(intro, fontSize = 15.sp, lineHeight = 22.sp)
                            }
                        }
                        e?.media?.filter { it.kind == "intro" }?.forEach { m ->
                            EncryptedMediaPlayer(m, e.transcripts?.firstOrNull { it.x == m.x })
                        }
                        if (skills.isNotEmpty()) ChipFlow(skills)
                        if (lookingFor.isNotEmpty()) Dim(s.t("attendee.lookingFor", "value" to lookingFor))
                        if (ai != null && ai.hasContent) SoftCard(color = t.bgElev2) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(s.t("attendee.aiSummary"), Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                if (e.aiProfileEdited == true) Chip(s.t("attendee.aiEdited"))
                            }
                            if (ai.summary.isNotBlank()) Dim(ai.summary)
                            aiFields.forEach { (key, items) ->
                                if (items.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Dim(s.t("profile.field.$key"), size = 12)
                                    ChipFlow(items)
                                }
                            }
                        }
                        // Follow / Message side by side; mute lives with the utilities below.
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (followKnown) FollowButton(pubkey, displayName, following, { }, FollowVariant.CTA, Modifier.weight(1f))
                            else OutlinedButton({}, Modifier.weight(1f).heightIn(min = 44.dp), enabled = false) { Text("…") }
                            OutlinedButton(
                                { if (account != null) router.go(Route.DmPeer(npub)) else router.go(Route.Login()) },
                                Modifier.weight(1f).heightIn(min = 44.dp), shape = RoundedCornerShape(10.dp),
                            ) { Text(s.t("attendee.message"), fontWeight = FontWeight.SemiBold, color = t.text) }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            IdChip(if (copied == "npub") s.t("attendee.id.copied") else s.t("attendee.id.copyNpub"), if (copied == "npub") Icons.Outlined.Check else Icons.Outlined.ContentCopy) { copy("npub") }
                            IdChip(if (copied == "nprofile") s.t("attendee.id.copied") else s.t("attendee.id.copyNprofile"), if (copied == "nprofile") Icons.Outlined.Check else Icons.Outlined.ContentCopy) { copy("nprofile") }
                            IdChip(s.t("attendee.id.njump"), Icons.AutoMirrored.Outlined.OpenInNew) { openExternal(ctx, "https://njump.me/$nprofile") }
                            if (muted) IdChip(s.t("attendee.unmute"), null, enabled = !busy) { toggleMute() }
                            else IdChip(s.t("attendee.mute"), null, danger = true, enabled = !busy) { confirmMute = !confirmMute }
                        }
                        if (confirmMute && !muted) SoftCard(color = t.warnSoft) {
                            Dim(s.t("mute.confirm"))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                SecondaryButton(s.t("attendee.mute"), { toggleMute() }, Modifier.weight(1f), busy = busy, danger = true)
                                SecondaryButton(s.t("attendee.mute.cancel"), { confirmMute = false }, Modifier.weight(1f))
                            }
                        }
                    }
                }
                if (myMatch != null) item {
                    Card {
                        Text(s.t("attendee.yourMatch"), color = t.textDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        MatchDetails(myMatch, Confidence.bandAtCut(myMatch.score, strongCut)) {
                            PrimaryButton(s.t("matches.introduce"), { introduce() }, icon = Icons.AutoMirrored.Outlined.Send)
                        }
                    }
                }
                val st = settings
                if (st != null && account != null) item {
                    Card {
                        Text(s.t("attendee.private"), color = t.textDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SmallButton(s.t("attendee.wantToMeet"), { toggle(SettingList.WANT_TO_MEET) }, selected = SettingsRules.has(st, SettingList.WANT_TO_MEET, pubkey))
                            SmallButton(s.t("attendee.met"), { toggle(SettingList.MET) }, selected = SettingsRules.has(st, SettingList.MET, pubkey))
                        }
                        Field(
                            noteDraft, { noteDraft = it; noteTouched = true }, s.t("attendee.note.placeholder"),
                            singleLine = false, minLines = 2,
                            supporting = when (noteState) { NoteState.SAVING -> s.t("profile.saving"); NoteState.SAVED -> s.t("profile.saved"); else -> null },
                        )
                    }
                }
                if (posts.isNotEmpty()) {
                    item { SectionTitle(s.t("attendee.recentPosts")) }
                    posts.sortedByDescending { it.createdAt }.take(20).forEach { p -> item(key = p.id) { NoteView(p) } }
                }
            }
        }
    }
}

@Composable
private fun IdChip(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector?, danger: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.clip(RoundedCornerShape(999.dp)).border(1.dp, if (danger) t.danger.copy(alpha = 0.4f) else t.border, RoundedCornerShape(999.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 11.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, Modifier.size(13.dp), tint = t.textDim); Spacer(Modifier.width(5.dp)) }
        Text(text, fontSize = 13.sp, color = if (danger) t.danger else t.text, fontWeight = FontWeight.Medium)
    }
}

internal fun openExternal(ctx: Context, url: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}
