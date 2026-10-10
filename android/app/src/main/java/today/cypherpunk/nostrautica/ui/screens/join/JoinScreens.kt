package today.cypherpunk.nostrautica.ui.screens.join

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.ProfileMeta
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.join.JoinInput
import today.cypherpunk.nostrautica.domain.join.JoinLanding
import today.cypherpunk.nostrautica.domain.join.JoinRules
import today.cypherpunk.nostrautica.domain.join.ProfileLoadState
import today.cypherpunk.nostrautica.domain.join.introMedia
import today.cypherpunk.nostrautica.domain.join.joinFlow
import today.cypherpunk.nostrautica.domain.media.PublicImages
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.nostr.Filter
import today.cypherpunk.nostrautica.nostr.Relays
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.Coordinate
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.Notice
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.SignInBody
import today.cypherpunk.nostrautica.ui.screens.afterLogin
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.EventState
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/**
 * pages/Join.svelte: the form (new identity inline, or a signed-in Nostr user),
 * the invite code, the optional public RSVP, intro reuse, then "request sent"
 * with a visible approval poll, then "You're in".
 */
@Composable
fun JoinScreen(r: Route.Join) {
    EventScaffold(r.naddr) { p ->
        val ev = LocalEvent.current
        val c = LocalContainer.current
        val router = LocalRouter.current
        // The invite code is a secret riding the link: move it into memory and drop
        // it from the back stack at once, so no later navigation rebuilds it.
        LaunchedEffect(r.code) {
            val code = r.code ?: return@LaunchedEffect
            c.joinFlow.storeInvite(ev.coordinate, code)
            router.replace(Route.Join(r.naddr))
        }
        if (r.code != null) Page(p) { item { Loading() } } else JoinBody(ev, p)
    }
}

@Composable
private fun JoinBody(ev: EventState, p: androidx.compose.foundation.layout.PaddingValues) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val account by c.session.account.collectAsState()
    val needsBackup by c.session.needsBackup.collectAsState()
    val network by c.nostr.network.collectAsState()
    val coord = ev.coordinate
    val code = remember(coord) { c.joinFlow.loadInvite(coord) }

    var approved by remember { mutableStateOf(ev.isMember) }
    var sent by remember { mutableStateOf(false) }
    var sentQueued by remember { mutableStateOf(false) }
    var landed by remember { mutableStateOf(false) }
    var introDone by remember { mutableStateOf(false) }
    var lastCheckedAt by remember { mutableStateOf<Long?>(null) }
    var pollSec by remember { mutableStateOf(5) }
    var pollToken by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showErrors by remember { mutableStateOf(false) }
    var showSignIn by remember { mutableStateOf(false) }
    var photoNotice by remember { mutableStateOf(false) }

    // New identity (we generate the key): these become the public kind 0.
    var newName by remember { mutableStateOf("") }
    var newAbout by remember { mutableStateOf("") }
    var newPhoto by remember { mutableStateOf<Uri?>(null) }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) newPhoto = uri }

    // Signed-in Nostr user: kind 0 read-only; event-local name/bio never touch it.
    var profileState by remember { mutableStateOf(ProfileLoadState.IDLE) }
    var existing by remember { mutableStateOf(JoinRules.LoadedProfile(ProfileLoadState.IDLE, "", "", "")) }
    var eventDisplayName by remember { mutableStateOf("") }
    var eventAbout by remember { mutableStateOf("") }
    var skills by remember { mutableStateOf("") }
    var lookingFor by remember { mutableStateOf("") }
    var rsvpPublic by remember { mutableStateOf(false) }

    // Intro reuse from the library (the newest intro, offered generically).
    var reusable by remember { mutableStateOf<MediaDescriptor?>(null) }
    var reuseChoice by remember { mutableStateOf("reuse") }

    val loggedIn = account != null
    val hasPublicAbout = profileState == ProfileLoadState.LOADED && existing.about.isNotBlank()
    val aboutValue = if (loggedIn) (if (hasPublicAbout) existing.about else eventAbout) else newAbout
    val nameInvalid = if (loggedIn) !JoinRules.canSubmitLoggedIn(profileState, eventDisplayName) else newName.isBlank()
    val profileWillBeEmpty = aboutValue.isBlank() && skills.isBlank() && lookingFor.isBlank()

    suspend fun isApproved(pk: String) = c.membership.role(pk, coord).let { it == Role.ATTENDEE || it == Role.ORGANIZER }

    suspend fun checkIntro() {
        val a = c.session.account.value ?: return
        runCatching {
            val bk = c.accounts.blindingKey()
            introDone = c.introMedia.loadSelfCopy(a.signer, ev.ctx, bk)?.hasIntro == true
        }
    }

    suspend fun loadExistingProfile() {
        val a = c.session.account.value ?: return
        profileState = ProfileLoadState.LOADING
        val local = c.profiles.local(a.pubkey)
        val answered = runCatching { c.nostr.fetch(Relays.READ, Filter(kinds = listOf(Kinds.PROFILE), authors = listOf(a.pubkey))).answered }.getOrDefault(0)
        val meta: ProfileMeta? = c.profiles.local(a.pubkey) ?: local
        val r = JoinRules.classifyProfile(meta?.name, meta?.about, meta?.picture, failed = meta == null && answered == 0)
        existing = r
        profileState = r.state
        if (r.state == ProfileLoadState.LOADED && eventDisplayName.isBlank()) eventDisplayName = r.name
    }

    // Landing: grants scan (bounded), then approved / waiting / form.
    LaunchedEffect(account?.pubkey) {
        val a = account ?: run { landed = true; return@LaunchedEffect }
        if (!isApproved(a.pubkey)) runCatching { c.grants.receive(a.signer, maxUnwraps = 10) }
        approved = isApproved(a.pubkey)
        when (JoinRules.landing(approved, c.membership.joinSentAt(a.pubkey, coord) != null, code != null)) {
            JoinLanding.APPROVED -> { c.membership.clearJoinSent(a.pubkey, coord); checkIntro() }
            JoinLanding.WAITING -> { sent = true; pollToken++ }
            JoinLanding.FORM -> {}
        }
        landed = true
        if (profileState == ProfileLoadState.IDLE) loadExistingProfile()
        runCatching {
            val lib = c.introMedia.loadLibraryFull(a.signer, c.accounts.blindingKey())
            reusable = lib.media.lastOrNull { it.kind == "intro" }
        }
    }

    // Poll for the grant while this screen is on screen (never in the background):
    // fast for an invite, 5 s for a human, 60 s once it is clearly a wait.
    LaunchedEffect(pollToken, account?.pubkey) {
        val a = account ?: return@LaunchedEffect
        if (pollToken == 0 || approved) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            val started = System.currentTimeMillis()
            val fast = if (code != null) 10 else 0
            var i = 0
            while (!approved) {
                val gap = JoinRules.pollGapMs(i++, fast, System.currentTimeMillis() - started)
                pollSec = (gap / 1000).toInt().coerceAtLeast(1)
                delay(gap)
                runCatching { c.grants.receive(a.signer, maxUnwraps = 10) }
                lastCheckedAt = System.currentTimeMillis()
                approved = isApproved(a.pubkey)
            }
            c.membership.clearJoinSent(a.pubkey, coord)
            checkIntro()
        }
    }

    fun submit() {
        error = null
        if (nameInvalid) { showErrors = true; return }
        busy = true
        scope.launch {
            try {
                val displayName: String
                val about: String
                if (c.session.account.value == null) {
                    // Prepare the photo BEFORE creating the key: a bad image fails closed, with no side effects.
                    val avatar = newPhoto?.let { PublicImages.prepareAvatar(ctx, it) }
                    val acct = c.session.createLocalKey()
                    displayName = newName.trim()
                    about = newAbout.trim()
                    val picture = avatar?.let { bytes ->
                        runCatching { PublicImages.upload(c.introMedia, acct.signer, bytes, "image/jpeg", ev.ctx.cfg.blossom) }
                            .onFailure { photoNotice = true }.getOrNull()
                    }
                    // Only for a key WE generated do we publish kind 0 (§5.4).
                    runCatching { c.social.onboard(displayName, picture, about.ifEmpty { null }) }
                    runCatching { c.social.seedFollows(Coordinate.parse(coord).pubkey) }
                    afterLogin(c)
                } else {
                    val a = c.session.account.value!!
                    if (a.method == Session.Method.LOCAL && c.session.needsBackup.value) runCatching { c.social.seedFollows(Coordinate.parse(coord).pubkey) }
                    if (profileState == ProfileLoadState.IDLE || profileState == ProfileLoadState.LOADING) loadExistingProfile()
                    if (!JoinRules.canSubmitLoggedIn(profileState, eventDisplayName)) { showErrors = true; return@launch }
                    displayName = eventDisplayName.trim().ifEmpty { existing.name }
                    // Only what they wrote FOR THIS EVENT: a copy of the kind-0 bio would freeze it forever.
                    about = eventAbout.trim()
                }
                val a = c.session.account.value ?: error("not signed in")
                val bk = c.accounts.blindingKey()
                val reuse = reusable
                val reuseMedia = if (reuse != null && reuseChoice != "new") {
                    runCatching { listOf(c.introMedia.prepareReuse(a.signer, ev.ctx, reuse, reuseChoice == "fresh")) }.getOrDefault(emptyList())
                } else emptyList()
                val published = c.joinFlow.sendJoinRequest(
                    a.signer, ev.ctx,
                    JoinInput(
                        name = displayName,
                        rsvpPublic = rsvpPublic,
                        profile = AttendeeProfile(about, skills.split(',').map { it.trim() }.filter { it.isNotEmpty() }, lookingFor.trim(), emptyList()),
                        media = reuseMedia,
                        inviteNsec = code,
                    ),
                    bk,
                )
                sent = true
                sentQueued = !published
                c.joinFlow.clearInvite(coord)
                c.membership.markJoinSent(a.pubkey, coord)
                pollToken++
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = errorText(e, s)
            } finally {
                busy = false
            }
        }
    }

    Page(p) {
        error?.let { msg -> item { ErrorCard(msg) } }
        when {
            !landed -> item { Loading(s.t("join.loading")) }
            approved -> {
                item { ScreenTitle(s.t("join.youreIn")) }
                item {
                    Card {
                        if (!introDone) {
                            PrimaryButton(s.t("join.recordIntro"), { router.go(Route.Record(ev.naddr)) })
                            SecondaryButton(s.t("join.goToOverview"), { router.switchTo(Route.Event(ev.naddr)) })
                            var why by remember { mutableStateOf(false) }
                            LinkButton(s.t("join.whyIntro.summary"), { why = !why })
                            if (why) {
                                Dim(s.t("join.whyIntro.intro"))
                                Dim("• " + s.t("join.whyIntro.matches"))
                                Dim("• " + s.t("join.whyIntro.vibe"))
                                Dim("• " + s.t("join.whyIntro.recognize"))
                            }
                        } else {
                            PrimaryButton(s.t("join.goToOverview"), { router.switchTo(Route.Event(ev.naddr)) })
                            SecondaryButton(s.t("join.seeWhosHere"), { router.switchTo(Route.Attendees(ev.naddr)) })
                        }
                    }
                }
                if (photoNotice) item { Notice(s.t("join.android.photoNotUploaded"), t.warnSoft) }
                if (account?.method == Session.Method.LOCAL && needsBackup) item {
                    Card {
                        SectionTitle(s.t("join.backupIdentity"))
                        Dim(s.t("home.backup.body"))
                        PrimaryButton(s.t("home.backup.now"), { router.go(Route.Me) })
                    }
                }
            }
            sent -> {
                item { ScreenTitle(s.t("join.requestSent")) }
                if (photoNotice) item { Notice(s.t("join.android.photoNotUploaded"), t.warnSoft) }
                item {
                    Card {
                        if (sentQueued || !network) Text(s.t("sync.queued"), color = t.warn)
                        Text(if (code != null) s.t("join.waiting.invite") else s.t("join.waiting.manual"))
                        val at = lastCheckedAt
                        Dim(
                            (if (at != null) s.t("join.waiting.checked", "time" to clockTime(at, s.locale), "sec" to pollSec) else s.t("join.waiting.checking", "sec" to pollSec)) +
                                "\n" + s.t("join.waiting.canClose"),
                            size = 13,
                        )
                        PrimaryButton(s.t("join.backToEvent"), { router.switchTo(Route.Event(ev.naddr)) })
                        SecondaryButton(s.t("join.myEvents"), { router.resetTo(Route.Home) })
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Dim(s.t("join.notThrough"), size = 13)
                            LinkButton(s.t("join.sendAgain"), {
                                account?.let { c.membership.clearJoinSent(it.pubkey, coord) }
                                sent = false
                            })
                        }
                    }
                }
            }
            else -> {
                item { ScreenTitle(s.t("join.title", "title" to ev.ctx.title)) }
                ev.ctx.cfg.retentionDays?.let { d -> item { Dim(s.t("join.retention", "days" to d), size = 13) } }
                if (!loggedIn) item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        PrimaryButton(s.t("join.alreadyOnNostr"), { showSignIn = !showSignIn }, icon = Icons.Outlined.Key)
                        if (showSignIn) SignInBody(null, onDone = { showSignIn = false }, showCreate = false)
                        Text(s.t("join.or"), Modifier.fillMaxWidth(), color = t.textDim, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                }
                if (code != null) item { Pill(s.t("join.inviteRecognized"), t.okSoft, t.ok) }
                item {
                    Card {
                        if (loggedIn) {
                            when (profileState) {
                                ProfileLoadState.IDLE, ProfileLoadState.LOADING -> Dim(s.t("join.fetchingProfile"))
                                ProfileLoadState.FAILED -> SoftCard(color = t.warnSoft) {
                                    Text(s.t("join.profile.failed.title"), fontWeight = FontWeight.SemiBold)
                                    Dim(s.t("join.profile.failed.body"))
                                    LinkButton(s.t("join.profile.retry"), { scope.launch { loadExistingProfile() } })
                                }
                                ProfileLoadState.LOADED -> {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        if (existing.picture.isNotEmpty()) {
                                            AsyncImage(existing.picture, null, Modifier.size(56.dp).clip(CircleShape), contentScale = ContentScale.Crop)
                                            Spacer(Modifier.width(12.dp))
                                        }
                                        if (existing.about.isNotEmpty()) Column {
                                            Text(s.t("join.aboutYou"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                            Dim(existing.about, maxLines = 6)
                                        }
                                    }
                                    Dim(s.t("join.fromProfile"), size = 13)
                                }
                                ProfileLoadState.EMPTY -> Dim(s.t("join.profile.empty"))
                            }
                            if (profileState != ProfileLoadState.IDLE && profileState != ProfileLoadState.LOADING) {
                                Field(eventDisplayName, { eventDisplayName = it }, s.t("join.displayName") + " " + s.t("join.displayNameEvent"),
                                    placeholder = s.t("join.namePlaceholder"), isError = showErrors && nameInvalid,
                                    supporting = if (showErrors && nameInvalid) s.t("join.error.nameRequired") else null)
                                if (!hasPublicAbout) {
                                    Field(eventAbout, { if (it.length <= Limits.MAX_ABOUT) eventAbout = it }, s.t("join.aboutYou") + " " + s.t("join.aboutEvent"),
                                        placeholder = s.t("join.about.placeholder"), singleLine = false, minLines = 3)
                                }
                            }
                        } else {
                            Dim(s.t("join.publicNote"))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier.size(64.dp).clip(CircleShape).border(1.dp, t.border, CircleShape)
                                        .clickable { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    val ph = newPhoto
                                    if (ph != null) AsyncImage(ph, null, Modifier.size(64.dp).clip(CircleShape), contentScale = ContentScale.Crop)
                                    else Icon(Icons.Outlined.Add, s.t("join.photoAdd"), tint = t.textDim)
                                }
                                Spacer(Modifier.width(12.dp))
                                Column {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Dim(s.t("join.photoAdd"), size = 13)
                                        Pill(s.t("join.photoPublic"), t.bgElev2, t.textDim)
                                    }
                                    Dim(s.t("join.photoTap"), size = 13)
                                    if (newPhoto != null) LinkButton(s.t("join.android.photoRemove"), { newPhoto = null })
                                }
                            }
                            Field(newName, { newName = it }, s.t("join.displayName") + " " + s.t("join.displayNamePublic"),
                                placeholder = s.t("join.namePlaceholder"), isError = showErrors && nameInvalid,
                                supporting = if (showErrors && nameInvalid) s.t("join.error.nameRequired") else null)
                            Field(newAbout, { if (it.length <= Limits.MAX_ABOUT) newAbout = it }, s.t("join.aboutYou") + " " + s.t("join.aboutOptional"), singleLine = false, minLines = 3)
                        }

                        Dim(s.t("join.concreteHint"), size = 13)
                        Field(skills, { skills = it }, s.t("join.skills") + " " + s.t("join.skills.hint"), placeholder = s.t("join.skills.placeholder"))
                        Field(lookingFor, { lookingFor = it }, s.t("join.lookingFor"), placeholder = s.t("join.lookingFor.placeholder"))
                        if (profileWillBeEmpty) Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Pill(s.t("join.empty.badge"), t.warnSoft, t.warn)
                        }
                        if (profileWillBeEmpty) Dim(s.t("join.empty.hint"), size = 13)
                        CheckRow(rsvpPublic, { rsvpPublic = it }, s.t("join.rsvpPublic"))

                        reusable?.let { m ->
                            SoftCard(color = t.bgElev2) {
                                Text(s.t("join.reuse.title"), fontWeight = FontWeight.SemiBold)
                                Dim(s.t("join.reuse.body", "duration" to (m.duration?.toLong()?.toString() ?: "?")))
                                RadioRow(reuseChoice == "reuse", { reuseChoice = "reuse" }, s.t("join.reuse.reuse"), s.t("join.reuse.reuse.hint"))
                                RadioRow(reuseChoice == "fresh", { reuseChoice = "fresh" }, s.t("join.reuse.fresh"), s.t("join.reuse.fresh.hint"))
                                RadioRow(reuseChoice == "new", { reuseChoice = "new" }, s.t("join.reuse.new"), s.t("join.reuse.new.hint"))
                            }
                        }

                        PrimaryButton(
                            if (busy) s.t("join.sending") else if (loggedIn) s.t("join.send") else s.t("join.createAndJoin"),
                            ::submit,
                            enabled = !(loggedIn && (profileState == ProfileLoadState.LOADING || profileState == ProfileLoadState.IDLE)),
                            busy = busy,
                        )
                    }
                }
            }
        }
    }
}
