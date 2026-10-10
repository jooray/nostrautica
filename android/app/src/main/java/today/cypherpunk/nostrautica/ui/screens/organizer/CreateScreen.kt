package today.cypherpunk.nostrautica.ui.screens.organizer

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import today.cypherpunk.nostrautica.domain.organizer.CoordinatorHelpers
import today.cypherpunk.nostrautica.domain.organizer.CreateEventInput
import today.cypherpunk.nostrautica.domain.organizer.CreationReceipt
import today.cypherpunk.nostrautica.domain.organizer.DuplicateDraft
import today.cypherpunk.nostrautica.domain.organizer.Organizer
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.avatarHues
import today.cypherpunk.nostrautica.ui.components.hsl
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.BackupCard
import today.cypherpunk.nostrautica.ui.shell.GlobalScaffold
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/** The generated default artwork (media/image.ts defaultEventIcon/Banner): a seeded gradient. */
@Composable
fun GradientArt(seed: String, modifier: Modifier) {
    val (h1, h2) = avatarHues(seed.ifEmpty { "event" })
    Box(modifier.background(Brush.linearGradient(listOf(hsl(h1, 0.62f, 0.42f), hsl(h2, 0.58f, 0.30f)))))
}

/** An icon (1:1) or banner (5:2) slot: shows the uploaded URL, else the held crop, else the gradient. */
@Composable
fun ImagePreview(url: String, held: ByteArray?, seed: String, banner: Boolean) {
    val allow by LocalContainer.current.prefs.externalImages.collectAsState()
    val m = if (banner) Modifier.fillMaxWidth().aspectRatio(2.5f).clip(RoundedCornerShape(12.dp))
    else Modifier.size(64.dp).clip(RoundedCornerShape(14.dp))
    Box(m) {
        GradientArt(seed, Modifier.fillMaxSize())
        val model: Any? = held ?: url.takeIf { it.isNotBlank() && allow }
        if (model != null) AsyncImage(model, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}

/** The two image slots with pick / from-URL / reset (shared by Create and Settings). */
@Composable
fun ImageSlots(
    title: String,
    icon: String, onIcon: (String) -> Unit,
    banner: String, onBanner: (String) -> Unit,
    heldIcon: ByteArray?, heldBanner: ByteArray?,
    uploading: String?,
    onPick: (which: String) -> Unit,
    onReset: () -> Unit,
) {
    val s = LocalStrings.current
    var linkWhich by remember { mutableStateOf<String?>(null) }
    var linkUrl by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FieldLabel(s.t("create.field.images"), s.t("create.field.images.optional"))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ImagePreview(icon, heldIcon, title, banner = false)
                SmallButton(if (uploading == "icon") "…" else s.t("create.icon"), { onPick("icon") })
                SmallButton(s.t("create.imageUrl"), { linkWhich = "icon"; linkUrl = icon })
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ImagePreview(banner, heldBanner, title, banner = true)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SmallButton(if (uploading == "banner") "…" else s.t("create.banner"), { onPick("banner") })
                    SmallButton(s.t("create.imageUrl"), { linkWhich = "banner"; linkUrl = banner })
                }
                if (icon.isNotEmpty() || banner.isNotEmpty() || heldIcon != null || heldBanner != null) SmallButton(s.t("create.reset"), { onReset(); linkWhich = null })
            }
        }
        linkWhich?.let { which ->
            val norm = CoordinatorHelpers.externalImageUrl(linkUrl)
            val invalid = linkUrl.isNotBlank() && norm == null
            Field(
                linkUrl, { linkUrl = it },
                if (which == "icon") s.t("create.imageUrl.labelIcon") else s.t("create.imageUrl.labelBanner"),
                placeholder = s.t("create.imageUrl.placeholder"), isError = invalid,
                supporting = if (invalid) s.t("create.imageUrl.invalid") else null,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SmallButton(s.t("create.imageUrl.use"), { norm?.let { if (which == "icon") onIcon(it) else onBanner(it) }; linkWhich = null }, enabled = norm != null)
                SmallButton(s.t("create.imageUrl.cancel"), { linkWhich = null })
            }
        }
        Dim(s.t("create.images.body"), size = 13)
    }
}

private fun minutesText(sec: Int) = (sec / 60.0).let { if (it == Math.floor(it)) it.toInt().toString() else it.toString() }

/** pages/Create.svelte: event or community, then a receipt with retryable steps. */
@Composable
fun CreateScreen() {
    val s = LocalStrings.current
    val router = LocalRouter.current
    GlobalScaffold(back = s.t("common.back") to { if (!router.back()) router.resetTo(Route.Home) }) { p -> CreateBody(p) }
}

@Composable
private fun CreateBody(p: androidx.compose.foundation.layout.PaddingValues) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val router = LocalRouter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val needsBackup by c.session.needsBackup.collectAsState()
    val org = c.organizer

    var community by rememberSaveable { mutableStateOf(false) }
    var title by rememberSaveable { mutableStateOf("") }
    var summary by rememberSaveable { mutableStateOf("") }
    var start by rememberSaveable { mutableStateOf<Long?>(null) }
    var end by rememberSaveable { mutableStateOf<Long?>(null) }
    var location by rememberSaveable { mutableStateOf("") }
    var iconUrl by rememberSaveable { mutableStateOf("") }
    var bannerUrl by rememberSaveable { mutableStateOf("") }
    var heldIcon by remember { mutableStateOf<ByteArray?>(null) }
    var heldBanner by remember { mutableStateOf<ByteArray?>(null) }
    var uploading by remember { mutableStateOf<String?>(null) }
    var maxVideo by rememberSaveable { mutableStateOf("1.5") }
    var videoUnlimited by rememberSaveable { mutableStateOf(false) }
    var maxTalk by rememberSaveable { mutableStateOf("15") }
    var talkUnlimited by rememberSaveable { mutableStateOf(false) }
    var talks by rememberSaveable { mutableStateOf("off") }
    var matching by rememberSaveable { mutableStateOf(true) }
    var matchVisibility by rememberSaveable { mutableStateOf("pair") }
    var enrollSelf by rememberSaveable { mutableStateOf(true) }
    var chatEnabled by rememberSaveable { mutableStateOf(false) }
    var coordinator by rememberSaveable { mutableStateOf<String?>(null) }
    var approval by rememberSaveable { mutableStateOf("manual+invite") }
    var lang by rememberSaveable { mutableStateOf("en") }
    var organizerName by rememberSaveable { mutableStateOf("") }
    var duplicatedFrom by rememberSaveable { mutableStateOf<String?>(null) }

    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showErrors by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<Organizer.CreateResult?>(null) }
    var enrollFailed by remember { mutableStateOf(false) }
    var attachFailed by remember { mutableStateOf(false) }
    var retrying by remember { mutableStateOf<String?>(null) }
    var pickWhich by remember { mutableStateOf("icon") }
    var loaded by remember { mutableStateOf(false) }

    // Duplicate-event prefill, then the persisted title/summary drafts.
    LaunchedEffect(Unit) {
        DuplicateDraft.take()?.let { d ->
            title = d.title; summary = d.summary; iconUrl = d.iconUrl; bannerUrl = d.bannerUrl; talks = d.talks
            matching = d.matching; matchVisibility = d.matchVisibility; approval = d.approval; lang = d.lang
            videoUnlimited = d.maxVideoSec == EventConfig.UNLIMITED_SEC; if (!videoUnlimited) maxVideo = minutesText(d.maxVideoSec)
            talkUnlimited = d.maxTalkSec == EventConfig.UNLIMITED_SEC; if (!talkUnlimited) maxTalk = minutesText(d.maxTalkSec)
            chatEnabled = d.chatEnabled; duplicatedFrom = d.title
        }
        if (account != null) {
            if (title.isEmpty()) title = org.loadDraft("create:title") ?: ""
            if (summary.isEmpty()) summary = org.loadDraft("create:summary") ?: ""
        }
        loaded = true
    }
    LaunchedEffect(title, summary, loaded) {
        if (!loaded || result != null) return@LaunchedEffect
        delay(600)
        org.saveDraft("create:title", title)
        org.saveDraft("create:summary", summary)
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val which = pickWhich
        scope.launch {
            error = null
            uploading = which
            runCatching {
                val bytes = withContext(Dispatchers.IO) {
                    if (which == "icon") ImageCrop.centerCrop(ctx, uri, 1f, 512) else ImageCrop.centerCrop(ctx, uri, 2.5f, 1500)
                }
                val a = c.session.account.value
                if (a == null) {
                    // Logged out: hold the crop; it uploads on submit once the identity exists (U12).
                    if (which == "icon") { heldIcon = bytes; iconUrl = "" } else { heldBanner = bytes; bannerUrl = "" }
                } else {
                    val url = org.blossom.uploadPublicImage(a.signer, bytes)
                    if (which == "icon") { iconUrl = url; heldIcon = null } else { bannerUrl = url; heldBanner = null }
                }
            }.onFailure { error = s.t("create.error.uploadFailed", "reason" to (it.message ?: it.toString())) }
            uploading = null
        }
    }

    val endBeforeStart = start != null && end != null && end!! <= start!!
    val errName = if (account == null && organizerName.isBlank()) s.t("create.error.nameRequired") else null
    val errTitle = if (title.isBlank()) s.t("create.error.titleRequired") else null
    val errStart = if (!community && start == null) s.t("create.error.startRequired") else null
    val errEnd = if (endBeforeStart) s.t("create.error.endBeforeStart") else null

    fun input() = CreateEventInput(
        title = title.trim(), summary = summary.trim(),
        start = if (community) null else start, end = if (community) null else end,
        location = if (community) null else location.trim().ifEmpty { null },
        icon = iconUrl.trim().ifEmpty { null }, banner = bannerUrl.trim().ifEmpty { null },
        maxVideoSec = if (videoUnlimited) 0 else maxOf(1, Math.round((maxVideo.toDoubleOrNull() ?: 1.5) * 60).toInt()),
        maxTalkSec = if (talkUnlimited) 0 else maxOf(1, Math.round((maxTalk.toDoubleOrNull() ?: 15.0) * 60).toInt()),
        matching = matching, matchVisibility = matchVisibility, approval = approval, community = community,
        nostrContext = 100, lang = lang, talks = if (community) "off" else talks, chat = if (chatEnabled) listOf("marmot") else emptyList(),
    )

    fun submit() {
        error = null
        if (listOfNotNull(errName, errTitle, errStart, errEnd).isNotEmpty()) { showErrors = true; return }
        busy = true
        scope.launch {
            try {
                if (c.session.account.value == null) {
                    c.session.createLocalKey()
                    runCatching { c.social.onboard(organizerName.trim()) }
                }
                val a = c.session.account.value ?: throw IllegalStateException(s.t("create.error.identityFailed"))
                try {
                    heldIcon?.let { iconUrl = org.blossom.uploadPublicImage(a.signer, it); heldIcon = null }
                    heldBanner?.let { bannerUrl = org.blossom.uploadPublicImage(a.signer, it); heldBanner = null }
                } catch (e: Exception) {
                    error = s.t("create.error.uploadFailed", "reason" to (e.message ?: e.toString())); return@launch
                }
                val r = org.createEvent(input())
                if (c.session.needsBackup.value) runCatching { c.social.seedFollows(r.created.eidPubkey) }
                val ctxNow = runCatching { c.contexts.get(r.naddr) }.getOrNull()
                if (enrollSelf && ctxNow != null) enrollFailed = runCatching { org.enrollSelf(ctxNow) }.isFailure
                else if (enrollSelf) enrollFailed = true
                coordinator?.let { co ->
                    attachFailed = ctxNow == null || runCatching { org.attachCoordinator(ctxNow, co) }.isFailure
                }
                result = r
                c.membership.bump()
                if (r.published) {
                    Toasts.show(s.t("op.eventCreated"))
                    org.saveDraft("create:title", ""); org.saveDraft("create:summary", "")
                } else Toasts.show(s.t("op.eventCreateQueued"))
            } catch (e: Exception) {
                error = e.message ?: e.toString()
            } finally {
                busy = false
            }
        }
    }

    Page(p) {
        item { ScreenTitle(s.t("create.title")) }
        duplicatedFrom?.takeIf { result == null }?.let { d -> item { Card { Dim(s.t("create.duplicatedFrom", "title" to d)) } } }
        val r = result
        if (r != null) {
            item {
                val receipt = CreationReceipt.build(enrollSelf, enrollFailed, coordinator != null, attachFailed, needsBackup, false)
                Card {
                    SectionTitle(s.t("create.created"))
                    ReceiptLine(CreationReceipt.State.OK, s.t("create.receipt.event"))
                    if (receipt.enrolled != CreationReceipt.State.SKIPPED) {
                        ReceiptLine(receipt.enrolled, s.t("create.receipt.enrolled"))
                        if (receipt.enrolled == CreationReceipt.State.FAILED) {
                            Dim(s.t("create.step.enroll.failed.body"), size = 13)
                            SmallButton(if (retrying == "enroll") s.t("create.retrying") else s.t("create.retry"), {
                                retrying = "enroll"
                                scope.launch { enrollFailed = runCatching { org.enrollSelf(c.contexts.get(r.naddr)) }.isFailure; retrying = null }
                            }, enabled = retrying == null)
                        }
                    }
                    if (receipt.grant != CreationReceipt.State.SKIPPED) {
                        ReceiptLine(receipt.grant, s.t("create.receipt.grant"))
                        if (receipt.grant == CreationReceipt.State.OK) Dim(s.t("create.step.coordinator.attached.body"), size = 13)
                        else {
                            Dim(s.t("create.step.coordinator.failed.body"), size = 13)
                            SmallButton(if (retrying == "attach") s.t("create.retrying") else s.t("create.retry"), {
                                retrying = "attach"
                                scope.launch { attachFailed = runCatching { org.attachCoordinator(c.contexts.get(r.naddr), coordinator!!) }.isFailure; retrying = null }
                            }, enabled = retrying == null)
                        }
                    }
                    if (needsBackup) {
                        ReceiptLine(receipt.backup, s.t("create.receipt.backup"))
                        if (receipt.backup == CreationReceipt.State.PENDING) Dim(s.t("create.receipt.backup.pending.body"), size = 13)
                    }
                }
            }
            item {
                val link = Route.webUrl(Route.Event(r.naddr))
                Card {
                    Text("1. " + s.t("create.step.share"), fontWeight = FontWeight.SemiBold)
                    Text(link, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SmallButton(s.t("create.copyLink"), { copyText(ctx, link); Toasts.show(s.t("create.copied")) })
                        SmallButton(s.t("create.share"), { shareText(ctx, link, title.trim()) })
                    }
                    if (coordinator == null) {
                        Text("2. " + s.t("create.step.coordinator"), fontWeight = FontWeight.SemiBold)
                        Dim(s.t("create.step.coordinator.body"), size = 13)
                    }
                    Text((if (coordinator == null) "3. " else "2. ") + s.t("create.step.approve"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("create.step.approve.body"), size = 13)
                    PrimaryButton(s.t("create.openAdmin"), { router.replace(Route.Admin(r.naddr)) })
                    SecondaryButton(s.t("create.viewEvent"), { router.replace(Route.Event(r.naddr)) })
                }
            }
            if (needsBackup) item {
                Card {
                    SectionTitle(s.t("create.backupOrganizer"))
                    Dim(s.t("create.backupOrganizer.body"))
                    BackupCard()
                }
            }
            return@Page
        }

        error?.let { e -> item { ErrorCard(e) } }
        if (showErrors) listOfNotNull(errName, errTitle, errStart, errEnd).takeIf { it.isNotEmpty() }?.let { errs ->
            item { ErrorCard(errs.joinToString("\n")) }
        }
        item {
            Card {
                if (account == null) {
                    Field(organizerName, { organizerName = it }, s.t("create.organizerName"), placeholder = s.t("create.organizerName.placeholder"),
                        isError = showErrors && errName != null, supporting = if (showErrors) errName else null)
                    Dim(s.t("create.organizerName.body"), size = 13)
                }
                FieldLabel(s.t("create.field.kind"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SmallButton(s.t("create.kind.event"), { community = false; approval = "manual+invite" }, selected = !community)
                    SmallButton(s.t("create.kind.community"), { community = true; approval = "open"; talks = "off" }, selected = community)
                }
                Dim(if (community) s.t("create.kind.community.body") else s.t("create.kind.event.body"), size = 13)
                Field(title, { title = it }, s.t("create.field.title"), placeholder = s.t("create.field.title.placeholder"),
                    isError = showErrors && errTitle != null, supporting = if (showErrors) errTitle else null)
                Field(summary, { summary = it }, s.t("create.field.summary"), singleLine = false, minLines = 3)
                if (!community) {
                    DateTimeField(s.t("create.field.start"), start, { start = it }, error = if (showErrors) errStart else null)
                    DateTimeField(s.t("create.field.end"), end, { end = it }, error = errEnd, minSec = start)
                    Field(location, { location = it }, s.t("create.field.location"), placeholder = s.t("create.field.location.placeholder"))
                }
                LanguagePickerField(lang, { lang = it }, s.t("create.field.language"))
                Dim(s.t("create.field.language.body"), size = 13)
                ImageSlots(
                    title, iconUrl, { iconUrl = it; heldIcon = null }, bannerUrl, { bannerUrl = it; heldBanner = null }, heldIcon, heldBanner, uploading,
                    onPick = { pickWhich = it; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    onReset = { iconUrl = ""; bannerUrl = ""; heldIcon = null; heldBanner = null },
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    NumberField(maxVideo, { maxVideo = it }, s.t("create.field.maxVideo"), enabled = !videoUnlimited, decimal = true, modifier = Modifier.weight(1f))
                }
                ToggleRow(s.t("create.field.noLimit"), videoUnlimited, { videoUnlimited = it })
                // A community is always "open" (the kind description says so); only events choose.
                if (!community) ChoiceField(s.t("create.field.approval"), listOf("manual" to s.t("create.approval.manual"), "invite" to s.t("create.approval.invite"), "manual+invite" to s.t("create.approval.both")), approval, { approval = it })
                ChoiceField(s.t("create.field.matching"), listOf(true to s.t("create.matching.on"), false to s.t("create.matching.off")), matching, { matching = it })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(enrollSelf, { enrollSelf = it })
                    Text(s.t("create.field.enrollSelf"))
                }
                Dim(s.t("create.enrollSelf.body"), size = 13)
                if (!community) {
                    ChoiceField(s.t("create.field.talks"), listOf("off" to s.t("create.talks.off"), "on" to s.t("create.talks.on"), "prerecord-first" to s.t("create.talks.prerecordFirst")), talks, { talks = it })
                    Dim(s.t("create.field.talks.body"), size = 13)
                    if (talks != "off") {
                        NumberField(maxTalk, { maxTalk = it }, s.t("create.field.maxTalk"), enabled = !talkUnlimited, decimal = true)
                        ToggleRow(s.t("create.field.noLimit"), talkUnlimited, { talkUnlimited = it })
                    }
                }
                ToggleRow(s.t("chat.toggle.label"), chatEnabled, { chatEnabled = it }, badge = s.t("chat.toggle.experimental"))
                Dim(s.t("chat.toggle.help"), size = 13)
                if (chatEnabled) Dim(s.t("chat.toggle.needsCoordinator"), size = 13)
                FieldLabel(s.t("create.coordinator.title"), s.t("create.coordinator.optional"))
                Dim(s.t("create.coordinator.body"), size = 13)
                CoordinatorPicker(coordinator, { coordinator = it }, disabled = busy)
                Dim(s.t("create.rotationNote"), size = 13)
                PrimaryButton(
                    if (busy) s.t("create.creating") else if (community) s.t("create.submit.community") else s.t("create.submit"),
                    { submit() }, busy = busy,
                )
            }
        }
    }
}

@Composable
private fun ReceiptLine(state: CreationReceipt.State, label: String) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        when (state) {
            CreationReceipt.State.OK -> Pill(s.t("create.receipt.ok"), t.okSoft, t.ok)
            CreationReceipt.State.FAILED -> Pill(s.t("create.receipt.failed"), t.warnSoft, t.warn)
            else -> Pill(s.t("create.receipt.pending"), t.bgElev2, t.textDim)
        }
        Box(Modifier.width(8.dp))
        Text(label, fontSize = 15.sp)
    }
}
