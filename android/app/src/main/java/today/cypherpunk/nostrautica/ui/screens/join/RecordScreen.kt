package today.cypherpunk.nostrautica.ui.screens.join

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cameraswitch
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import today.cypherpunk.nostrautica.domain.Role
import today.cypherpunk.nostrautica.domain.join.AuthoredProfile
import today.cypherpunk.nostrautica.domain.join.JoinFlow
import today.cypherpunk.nostrautica.domain.join.introMedia
import today.cypherpunk.nostrautica.domain.join.joinFlow
import today.cypherpunk.nostrautica.domain.media.AudioTake
import today.cypherpunk.nostrautica.domain.media.CameraTake
import today.cypherpunk.nostrautica.domain.media.CaptureClock
import today.cypherpunk.nostrautica.domain.media.ExternalUrl
import today.cypherpunk.nostrautica.domain.media.LevelMeter
import today.cypherpunk.nostrautica.domain.media.LibraryOrder
import today.cypherpunk.nostrautica.domain.media.Outcome
import today.cypherpunk.nostrautica.domain.media.Precheck
import today.cypherpunk.nostrautica.domain.media.Take
import today.cypherpunk.nostrautica.domain.media.UserFacingError
import today.cypherpunk.nostrautica.domain.media.VideoShrink
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.IconSquare
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Notice
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.screens.shortDate
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.EventState
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.io.File

/** An unsent take, persisted so leaving the screen (or no network) never loses it. */
@Serializable
private data class TakeDraft(val path: String, val mime: String, val durationSec: Double, val mode: String, val picked: Boolean)

private enum class RecordRole { LOADING, VISITOR, PENDING, REVOKED, APPROVED }

/** pages/Record.svelte: video / audio / text intro, or a talk (record, upload, or URL). */
@Composable
fun RecordScreen(r: Route.Record) {
    EventScaffold(r.naddr) { p ->
        RecordBody(LocalEvent.current, r, p)
    }
}

@Composable
private fun RecordBody(ev: EventState, r: Route.Record, p: androidx.compose.foundation.layout.PaddingValues) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    val network by c.nostr.network.collectAsState()
    val upload by c.introMedia.blossom.progress.collectAsState()
    val talk = r.talk
    val kind = if (talk) "talk" else "intro"
    val kindLabel = if (talk) s.t("record.kind.talk") else s.t("record.kind.intro")
    val cfg = ev.ctx.cfg
    val maxSec = if (talk) cfg.maxTalkSec else cfg.maxVideoSec
    val unlimited = maxSec == EventConfig.UNLIMITED_SEC
    val hasCoordinator = cfg.coordinator != null
    val coord = ev.coordinate
    val takeKey = "draft:take:$coord:$kind"
    val textKey = "draft:intro:$coord"

    var role by remember { mutableStateOf(if (ev.isMember) RecordRole.APPROVED else RecordRole.LOADING) }
    var mode by remember { mutableStateOf("video") }
    var talkSource by remember { mutableStateOf("record") }
    var talkTitle by remember { mutableStateOf("") }
    var talkDescription by remember { mutableStateOf("") }
    var talkUrl by remember { mutableStateOf("") }
    var talkId by remember { mutableStateOf(JoinFlow.newTalkId()) }
    var talkRevision by remember { mutableStateOf(0L) }
    var editingTalk by remember { mutableStateOf(false) }
    var processForMatching by remember { mutableStateOf(false) }
    var disclosureAck by remember { mutableStateOf(false) }
    var showErrors by remember { mutableStateOf(false) }

    var recorded by remember { mutableStateOf<Take?>(null) }
    var recordedPicked by remember { mutableStateOf(false) }
    var takeRestored by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    var remaining by remember { mutableStateOf(0) }
    var cameraOn by remember { mutableStateOf(false) }
    var micOn by remember { mutableStateOf(false) }
    var front by remember { mutableStateOf(true) }
    var level by remember { mutableStateOf(0f) }
    var permissionKey by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var compressPct by remember { mutableStateOf<Int?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    var doneKey by remember { mutableStateOf("record.done.introPublished") }
    var doneQueued by remember { mutableStateOf(false) }

    var library by remember { mutableStateOf<List<MediaDescriptor>>(emptyList()) }
    var libraryAt by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
    var textLibrary by remember { mutableStateOf<List<String>>(emptyList()) }
    var textIntro by remember { mutableStateOf("") }
    var publishedIntro by remember { mutableStateOf("") }
    var introLoaded by remember { mutableStateOf(false) }
    var draftRestored by remember { mutableStateOf(false) }

    val camera = remember { CameraTake(ctx) }
    val audio = remember { AudioTake(ctx) }
    val meter = remember { LevelMeter() }
    // COMPATIBLE (TextureView): the default SurfaceView renders black inside a scrolling list.
    val previewView = remember { PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE } }
    var tickJob by remember { mutableStateOf<Job?>(null) }
    val shrinker = remember { VideoShrink(ctx) }

    val classified = if (talk && talkSource == "url") ExternalUrl.classify(talkUrl) else null
    val urlSource = talk && talkSource == "url"
    val showRecorder = !talk || talkSource == "record"
    val showUploadBtn = !talk || talkSource == "upload"
    val introLibrary = LibraryOrder.order(library.filter { it.kind == "intro" }, { it.x }, libraryAt)

    DisposableEffect(Unit) {
        onDispose {
            camera.release()
            meter.stop()
            if (recording) audio.cancel()
        }
    }

    // Role first (U5): no camera, picker or upload until we KNOW this is a member.
    LaunchedEffect(account?.pubkey) {
        val a = account ?: return@LaunchedEffect
        var role0 = c.membership.role(a.pubkey, coord)
        if (role0 != Role.ATTENDEE && role0 != Role.ORGANIZER) {
            runCatching { c.grants.receive(a.signer, maxUnwraps = 10) }
            role0 = c.membership.role(a.pubkey, coord)
        }
        val keys = c.eventKeys.get(a.pubkey, coord)
        role = when {
            keys?.current != null -> RecordRole.APPROVED
            keys != null && (keys.role == "attendee" || keys.role == "organizer") -> RecordRole.REVOKED
            role0 == Role.PENDING -> RecordRole.PENDING
            else -> RecordRole.VISITOR
        }
        if (role != RecordRole.APPROVED) return@LaunchedEffect
        // Editing an existing talk: prefill, same talk_d, bumped revision.
        if (talk && r.editTalk != null) {
            c.joinFlow.resolveTalkEdit(a.pubkey, ev.ctx, r.editTalk)?.let { d ->
                editingTalk = true; talkId = d.talkId; talkTitle = d.title; talkDescription = d.description; talkRevision = d.revision + 1
            }
        }
        // An unsent take from before (closed screen, no network) comes back.
        c.cache.get(a.pubkey, takeKey, TakeDraft.serializer())?.let { d ->
            val f = File(d.path)
            if (f.exists() && f.length() > 0) { recorded = Take(f, d.mime, d.durationSec); recordedPicked = d.picked; mode = d.mode; takeRestored = true }
            else c.cache.delete(a.pubkey, takeKey)
        }
        // Cache first, then the network (the library and the published text intro).
        c.introMedia.cachedLibrary(a.pubkey)?.let { library = it.media; libraryAt = it.at; textLibrary = it.texts }
        if (!talk) c.introMedia.cachedSelfCopy(a.pubkey, coord)?.introText?.let { textIntro = it; publishedIntro = it }
        runCatching {
            val bk = c.accounts.blindingKey()
            val lib = c.introMedia.loadLibraryFull(a.signer, bk)
            if (lib.known || lib.media.isNotEmpty()) { library = lib.media; libraryAt = lib.at; textLibrary = lib.texts }
            if (!talk) c.introMedia.loadSelfCopy(a.signer, ev.ctx, bk)?.introText?.let { if (textIntro == publishedIntro) textIntro = it; publishedIntro = it }
        }
        if (!talk) {
            val draft = c.cache.get(a.pubkey, textKey, String.serializer())
            if (!draft.isNullOrBlank() && draft != publishedIntro) { textIntro = draft; draftRestored = true }
            introLoaded = true
        }
    }

    // Persist the unsent text intro as it's typed (U9).
    LaunchedEffect(textIntro, introLoaded) {
        val a = account ?: return@LaunchedEffect
        if (!introLoaded || done) return@LaunchedEffect
        delay(400)
        if (textIntro == publishedIntro) c.cache.delete(a.pubkey, textKey) else c.cache.put(a.pubkey, textKey, String.serializer(), textIntro)
    }

    // The camera preview binds while enabled and not yet recorded.
    LaunchedEffect(cameraOn, front) {
        if (!cameraOn) return@LaunchedEffect
        runCatching { camera.bind(owner, previewView, front) }.onFailure {
            cameraOn = false; meter.stop(); error = s.t("record.deviceError.unknown.camera")
        }
    }

    suspend fun saveTake(take: Take, picked: Boolean) {
        val a = account ?: return
        c.cache.put(a.pubkey, takeKey, TakeDraft.serializer(), TakeDraft(take.file.path, take.mime, take.durationSec, mode, picked))
    }

    suspend fun clearTake(deleteFile: Boolean) {
        val a = account ?: return
        if (deleteFile) recorded?.file?.delete()
        c.cache.delete(a.pubkey, takeKey)
    }

    fun granted(vararg perms: String) = perms.all { ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED }

    var afterGrant by remember { mutableStateOf<(() -> Unit)?>(null) }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        if (res.values.all { it }) { permissionKey = null; afterGrant?.invoke() }
        else permissionKey = if (mode == "audio") "record.android.permission.mic" else "record.android.permission.camera"
        afterGrant = null
    }

    fun enableCamera(then: (() -> Unit)? = null) {
        error = null
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        val go = { cameraOn = true; meter.start(scope); then?.invoke(); Unit }
        if (granted(*perms)) go() else { afterGrant = go; permLauncher.launch(perms) }
    }

    fun enableMic(then: (() -> Unit)? = null) {
        error = null
        val go = { micOn = true; meter.start(scope); then?.invoke(); Unit }
        if (granted(Manifest.permission.RECORD_AUDIO)) go() else { afterGrant = go; permLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO)) }
    }

    fun switchMode(m: String) {
        if (m == mode) return
        camera.stop(); camera.release(); cameraOn = false
        meter.stop(); micOn = false
        if (recording) { audio.cancel(); recording = false }
        if (recorded != null) scope.launch { clearTake(deleteFile = true); recorded = null }
        error = null
        mode = m
    }

    fun startTicker(started: Long, levelOf: () -> Float) {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (recording) {
                remaining = CaptureClock.tick(System.currentTimeMillis() - started, maxSec)
                level = levelOf()
                delay(250)
            }
            level = 0f
        }
    }

    fun startRecording() {
        error = null
        if (mode == "audio") {
            if (!granted(Manifest.permission.RECORD_AUDIO)) { enableMic { startRecording() }; return }
            meter.stop()
            runCatching { audio.start() }.onFailure { error = s.t("record.deviceError.busy.mic"); return }
            recording = true
            val started = System.currentTimeMillis()
            startTicker(started) { audio.level() }
            if (!unlimited) scope.launch {
                delay(maxSec * 1000L)
                if (recording) { recording = false; audio.stop()?.let { recorded = it; recordedPicked = false; saveTake(it, false) }; micOn = false }
            }
        } else {
            if (!cameraOn || !granted(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) { enableCamera { startRecording() }; return }
            meter.stop()
            recording = true
            val started = System.currentTimeMillis()
            startTicker(started) { camera.level.value }
            scope.launch {
                runCatching { camera.record(maxSec) }
                    .onSuccess { take -> recorded = take; recordedPicked = false; saveTake(take, false) }
                    .onFailure { error = s.t("record.deviceError.unknown.camera") }
                recording = false
                // The take is done, so the camera light goes out NOW.
                camera.release()
                cameraOn = false
            }
        }
    }

    fun stopRecording() {
        if (mode == "audio") {
            recording = false
            scope.launch { audio.stop()?.let { recorded = it; recordedPicked = false; saveTake(it, false) }; micOn = false }
        } else camera.stop()
    }

    fun rejectOverLimits(size: Long, durationSec: Double): Boolean {
        val v = Precheck.check(size, durationSec, maxSec) ?: return false
        error = if (v.kind == "duration") s.t("record.error.tooLong", "limit" to v.limit, "actual" to v.actual)
        else s.t("record.error.tooLarge", "limitMb" to Precheck.MAX_UPLOAD_BYTES / (1024 * 1024))
        return true
    }

    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        error = null
        scope.launch {
            val cr = ctx.contentResolver
            val size = runCatching { cr.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else -1L } ?: -1L }.getOrDefault(-1L)
            if (size > Precheck.MAX_UPLOAD_BYTES) { rejectOverLimits(size, 0.0); return@launch }
            val probe = withContext(Dispatchers.IO) { shrinker.probe(uri) }
            val duration = probe?.durationSec ?: 0.0
            // A clip over the length limit is rejected before any copy or upload.
            if (rejectOverLimits(maxOf(size, 0), duration)) return@launch
            val mime = cr.getType(uri) ?: if (mode == "audio") "audio/mp4" else "video/mp4"
            val ext = if (mime.startsWith("audio/")) "m4a" else "mp4"
            val dest = File(File(ctx.cacheDir, "recordings").apply { mkdirs() }, "${java.util.UUID.randomUUID()}.$ext")
            val copied = runCatching { withContext(Dispatchers.IO) { cr.openInputStream(uri)?.use { i -> dest.outputStream().use { o -> i.copyTo(o) } } } }.isSuccess
            if (!copied || dest.length() == 0L) { dest.delete(); error = s.t("record.deviceError.unknown.camera"); return@launch }
            if (rejectOverLimits(dest.length(), duration)) { dest.delete(); return@launch }
            camera.release(); cameraOn = false; meter.stop(); micOn = false
            recorded?.file?.delete()
            val take = Take(dest, mime, duration)
            recorded = take
            recordedPicked = true
            saveTake(take, true)
        }
    }

    fun checkSubmit(needText: Boolean): Boolean {
        val ok = !(talk && talkTitle.isBlank()) && disclosureAck && !(needText && textIntro.isBlank()) && !(urlSource && classified == null)
        showErrors = !ok
        return ok
    }

    fun finish(outcome: Outcome) {
        done = true
        doneQueued = outcome != Outcome.PUBLISHED
        when {
            doneQueued -> { doneKey = "record.done.queued"; Toasts.show(s.t("op.queued", "what" to kindLabel)) }
            talk -> { doneKey = "record.done.talkModeration"; Toasts.show(s.t("op.talkAwaitingModeration")) }
            hasCoordinator -> { doneKey = "record.done.introProcessing"; Toasts.show(s.t("op.introSubmittedProcessing")) }
            else -> { doneKey = "record.done.introPublished"; Toasts.show(s.t("op.introPublished")) }
        }
    }

    suspend fun finishSubmitMedia(d: MediaDescriptor) {
        val a = account ?: return
        if (talk) {
            finish(c.joinFlow.submitTalk(a.signer, ev.ctx, talkId, talkTitle.trim(), talkDescription.trim(), talkRevision, media = d,
                sourceType = if (talkSource == "upload") "upload" else "recording", processForMatching = processForMatching))
            return
        }
        val bk = c.accounts.blindingKey()
        // The authored fields must survive a media submission (self-copy → cache → 31603).
        val self = c.introMedia.loadAuthoredState(a.signer, ev.ctx, bk)
        val keep = (self?.media ?: emptyList()).filter { it.kind != d.kind }
        finish(c.introMedia.submitProfileAndMedia(a.signer, ev.ctx, self?.profile ?: AuthoredProfile.empty(), keep + d, bk).aggregate)
    }

    fun runBusy(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try { block() } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = errorText(e, s)
            } finally { busy = false; compressPct = null }
        }
    }

    fun submitRecorded() {
        val take = recorded ?: return
        val a = account ?: return
        if (!checkSubmit(false)) return
        if (rejectOverLimits(take.file.length(), take.durationSec)) return
        if (!network) { error = s.t("record.android.needsNetwork"); return }
        runBusy {
            var file = take.file
            var mime = take.mime
            if (mime.startsWith("video/")) {
                compressPct = 0
                // Our own takes are already 720p; a picked file is always re-muxed to drop its location.
                shrinker.shrink(Uri.fromFile(take.file), always = recordedPicked) { compressPct = it }?.let { file = it; mime = "video/mp4" }
                compressPct = null
            }
            val bytes = withContext(Dispatchers.IO) { file.readBytes() }
            if (rejectOverLimits(bytes.size.toLong(), take.durationSec)) return@runBusy
            val d = c.introMedia.uploadMedia(a.signer, ev.ctx, bytes, mime, kind, Precheck.normalizeDurationSec(take.durationSec).toDouble())
            if (file != take.file) file.delete()
            finishSubmitMedia(d)
            clearTake(deleteFile = true)
            recorded = null
        }
    }

    fun submitText() {
        val a = account ?: return
        if (!checkSubmit(true)) return
        runBusy {
            val bk = c.accounts.blindingKey()
            val self = c.introMedia.loadAuthoredState(a.signer, ev.ctx, bk)
            // A text intro replaces any recorded intro.
            val media = (self?.media ?: emptyList()).filter { it.kind != kind }
            val out = c.introMedia.submitProfileAndMedia(a.signer, ev.ctx, self?.profile ?: AuthoredProfile.empty(), media, bk, textIntro.trim())
            publishedIntro = textIntro
            c.cache.delete(a.pubkey, textKey)
            draftRestored = false
            finish(out.aggregate)
        }
    }

    fun submitUrl() {
        val a = account ?: return
        if (!checkSubmit(false)) return
        val cls = classified ?: return
        runBusy {
            // External talks are never coordinator-processed, so the flag stays off.
            finish(c.joinFlow.submitTalk(a.signer, ev.ctx, talkId, talkTitle.trim(), talkDescription.trim(), talkRevision,
                externalUrl = cls.url, externalKind = cls.kind, sourceType = "external", processForMatching = false))
        }
    }

    fun reuse(d: MediaDescriptor, fresh: Boolean) {
        val a = account ?: return
        if (!checkSubmit(false)) return
        if (!network) { error = s.t("record.android.needsNetwork"); return }
        runBusy { finishSubmitMedia(c.introMedia.prepareReuse(a.signer, ev.ctx, d, fresh)) }
    }

    Page(p) {
        item { ScreenTitle(if (talk) s.t("record.talk.title") else s.t("record.intro.title")) }
        error?.let { msg -> item { ErrorCard(msg) } }
        permissionKey?.let { k ->
            item {
                SoftCard(color = t.dangerSoft) {
                    Text(s.t(k))
                    SmallButton(s.t("record.android.openSettings"), {
                        runCatching { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))) }
                    })
                }
            }
        }
        when {
            done -> item {
                Card {
                    Text(s.t(doneKey, "kind" to kindLabel), color = if (doneQueued) t.warn else t.text)
                    PrimaryButton(s.t("record.backToEvent"), { router.switchTo(Route.Event(ev.naddr)) })
                }
            }
            account == null -> item {
                Card {
                    Text(s.t("record.role.loggedOut"))
                    PrimaryButton(s.t("record.loginFirst"), { router.go(Route.Login()) })
                }
            }
            role == RecordRole.LOADING -> item { Card { Dim(s.t("record.role.resolving")) } }
            role == RecordRole.PENDING || role == RecordRole.REVOKED -> item {
                Card {
                    Text(if (role == RecordRole.PENDING) s.t("record.role.pending") else s.t("record.role.revoked"))
                    PrimaryButton(s.t("record.backToEvent"), { router.switchTo(Route.Event(ev.naddr)) })
                }
            }
            role == RecordRole.VISITOR -> item {
                Card {
                    Text(s.t("record.role.visitor"))
                    PrimaryButton(s.t("record.role.join"), { router.go(Route.Join(ev.naddr)) })
                    SecondaryButton(s.t("record.backToEvent"), { router.switchTo(Route.Event(ev.naddr)) })
                }
            }
            talk && cfg.talks == "off" -> item {
                Card {
                    Dim(s.t("talks.disabled"))
                    PrimaryButton(s.t("record.backToEvent"), { router.switchTo(Route.Event(ev.naddr)) })
                }
            }
            else -> {
                if (showErrors) item {
                    SoftCard(color = t.dangerSoft) {
                        if (talk && talkTitle.isBlank()) Text("• " + s.t("record.error.talkTitle"))
                        if (!disclosureAck) Text("• " + s.t("record.error.disclosure"))
                        if (mode == "text" && !talk && textIntro.isBlank()) Text("• " + s.t("record.error.textRequired"))
                        if (urlSource && classified == null) Text("• " + s.t("talks.url.invalid"))
                    }
                }
                if (!network) item { Notice(s.t("record.android.needsNetwork"), t.warnSoft) }
                if (talk) item {
                    Card {
                        if (editingTalk) Dim(s.t("talks.editing"))
                        Field(talkTitle, { if (it.length <= Limits.MAX_TALK_TITLE) talkTitle = it }, s.t("talks.field.title"), placeholder = s.t("talks.field.title.placeholder"),
                            isError = showErrors && talkTitle.isBlank(), supporting = if (showErrors && talkTitle.isBlank()) s.t("record.error.talkTitle") else null)
                        Field(talkDescription, { if (it.length <= Limits.MAX_TALK_DESC) talkDescription = it }, s.t("talks.field.description"), singleLine = false, minLines = 3)
                        if (urlSource) Dim(s.t("talks.process.externalNote"), size = 13)
                        else CheckRow(processForMatching, { processForMatching = it }, s.t("talks.process.label"), s.t("talks.process.hint"))
                    }
                }
                if (talk) item {
                    Card {
                        Text(s.t("talks.source.label"), fontWeight = FontWeight.SemiBold)
                        ToggleGroup(listOf("record" to s.t("talks.source.record"), "upload" to s.t("talks.source.upload"), "url" to s.t("talks.source.url")), talkSource) {
                            if (it != talkSource) { camera.release(); cameraOn = false; meter.stop(); micOn = false }
                            talkSource = it
                        }
                    }
                }
                if (!urlSource) item {
                    Card {
                        Text(s.t("record.mode.label"), fontWeight = FontWeight.SemiBold)
                        val modes = buildList {
                            add("video" to s.t("record.mode.video")); add("audio" to s.t("record.mode.audio"))
                            if (!talk) add("text" to s.t("record.mode.text"))
                        }
                        ToggleGroup(modes, mode, ::switchMode)
                    }
                }
                item {
                    SoftCard(color = t.bgElev2) {
                        Text(s.t("record.disclosure.title"), fontWeight = FontWeight.SemiBold)
                        Dim("• " + s.t("record.disclosure.attendees"))
                        if (hasCoordinator) {
                            Dim("• " + s.t("record.disclosure.coordinator"))
                            Dim("• " + if (mode == "text") s.t("record.disclosure.textProviders") else s.t("record.disclosure.providers"))
                        }
                        CheckRow(
                            disclosureAck, { disclosureAck = it },
                            when { !hasCoordinator -> s.t("record.disclosure.confirmNoCoord"); mode == "text" -> s.t("record.disclosure.confirmText"); else -> s.t("record.disclosure.confirm") },
                            isError = showErrors && !disclosureAck,
                        )
                    }
                }
                if (!talk && recorded == null && (introLibrary.isNotEmpty() || textLibrary.isNotEmpty())) {
                    item {
                        Card {
                            SectionTitle(s.t("record.reuse.title"))
                            Dim(s.t("record.reuse.body"))
                        }
                    }
                    for (m in introLibrary) item(key = m.x) {
                        Card {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Pill((if (m.isAudio) s.t("record.reuse.audioLabel") else s.t("record.reuse.videoLabel")) + (m.duration?.let { " · ${it.toLong()}s" } ?: ""), t.bgElev2, t.textDim)
                                libraryAt[m.x]?.let { Dim(shortDate(it, s.locale), size = 12) }
                            }
                            EncryptedClip(m)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                SmallButton(s.t("record.reuse.reuse"), { reuse(m, false) }, enabled = !busy)
                                SmallButton(s.t("record.reuse.fresh"), { reuse(m, true) }, enabled = !busy)
                            }
                        }
                    }
                    textLibrary.forEachIndexed { i, txt ->
                        item(key = "txt$i") {
                            Card {
                                Pill(s.t("record.reuse.textLabel"), t.bgElev2, t.textDim)
                                Dim(txt, maxLines = 4)
                                SmallButton(s.t("record.reuse.useText"), { textIntro = txt; switchMode("text") })
                            }
                        }
                    }
                }
                when {
                    urlSource -> item {
                        Card {
                            Field(talkUrl, { talkUrl = it.trim() }, s.t("talks.url.label"), placeholder = s.t("talks.url.placeholder"),
                                keyboard = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Uri),
                                isError = showErrors && classified == null, supporting = if (showErrors && classified == null) s.t("talks.url.invalid") else null)
                            Dim(s.t("talks.url.hint"), size = 13)
                            classified?.let { Pill(if (it.kind == "youtube") s.t("talks.url.detectedYoutube") else s.t("talks.url.detectedVideo"), t.okSoft, t.ok) }
                            PrimaryButton(if (busy) s.t("record.uploading") else s.t("talks.url.submit"), ::submitUrl, enabled = classified != null, busy = busy)
                        }
                    }
                    mode == "text" -> item {
                        Card {
                            SectionTitle(s.t("record.text.title"))
                            Dim(s.t("record.text.hint"))
                            if (draftRestored) Row(verticalAlignment = Alignment.CenterVertically) {
                                Dim(s.t("draft.restored"), Modifier.weight(1f), size = 13)
                                LinkButton(s.t("draft.discard"), {
                                    textIntro = publishedIntro; draftRestored = false
                                    account?.let { a -> scope.launch { c.cache.delete(a.pubkey, textKey) } }
                                })
                            }
                            Field(textIntro, { if (it.length <= Limits.MAX_INTRO_TEXT) textIntro = it }, s.t("record.text.title"),
                                placeholder = s.t("record.text.placeholder"), singleLine = false, minLines = 6,
                                isError = showErrors && textIntro.isBlank(), supporting = s.t("record.text.count", "n" to textIntro.length, "max" to Limits.MAX_INTRO_TEXT))
                            PrimaryButton(if (busy) s.t("record.uploading") else s.t("record.text.submit"), ::submitText, busy = busy)
                        }
                    }
                    else -> item {
                        Card {
                            val take = recorded
                            when {
                                take != null -> {
                                    if (takeRestored) Dim(s.t("record.android.takeRestored"), size = 13)
                                    FilePlayer(take.file, take.mime.startsWith("audio/"))
                                    Dim(s.t("record.recorded", "sec" to Precheck.normalizeDurationSec(take.durationSec)))
                                    compressPct?.let { pct ->
                                        ProgressLine(pct / 100f, s.t("record.android.compressing", "pct" to pct))
                                    }
                                    upload?.takeIf { busy && compressPct == null }?.let { u ->
                                        ProgressLine(u.sent.toFloat() / maxOf(1L, u.total), "${formatBytes(u.sent)} / ${formatBytes(u.total)}")
                                    }
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        SecondaryButton(s.t("record.reRecord"), {
                                            scope.launch { clearTake(deleteFile = true); recorded = null; takeRestored = false; error = null }
                                            if (!recordedPicked) { if (mode == "audio") enableMic() else enableCamera() }
                                        }, Modifier.weight(1f), enabled = !busy)
                                        val pct = upload?.let { (it.sent * 100 / maxOf(1L, it.total)).toInt() }
                                        PrimaryButton(
                                            if (busy && pct != null && compressPct == null) "${s.t("record.uploading")} $pct%" else if (busy) s.t("record.uploading") else s.t("record.useThis"),
                                            ::submitRecorded, Modifier.weight(1f), busy = busy && pct == null,
                                            enabled = !busy,
                                        )
                                    }
                                }
                                showRecorder -> {
                                    if (mode == "audio") {
                                        Dim(s.t("record.audio.hint"))
                                    } else if (cameraOn) {
                                        Box {
                                            AndroidView({ previewView }, Modifier.fillMaxWidth().height(320.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black))
                                            if (!recording) IconSquare(Icons.Outlined.Cameraswitch, s.t("record.android.switchCamera"), { front = !front }, Modifier.align(Alignment.TopEnd))
                                        }
                                    }
                                    val meterLevel by meter.level.collectAsState()
                                    if (micOn || cameraOn || recording) MicMeter(if (recording) level else meterLevel, s.t("record.micLevel"))
                                    Text(
                                        (if (unlimited) s.t("record.limit.unlimited") else s.t("record.limit", "sec" to maxSec)) +
                                            if (recording) (if (unlimited) s.t("record.elapsed", "sec" to remaining) else s.t("record.timeLeft", "sec" to remaining)) else "",
                                        fontWeight = if (recording) FontWeight.SemiBold else FontWeight.Normal,
                                    )
                                    if (recording) SecondaryButton(s.t("record.stop"), ::stopRecording, danger = true)
                                    else {
                                        when {
                                            mode == "audio" && micOn -> Pill(s.t("record.micReady"), t.okSoft, t.ok)
                                            mode != "audio" && cameraOn -> Pill(s.t("record.camReady"), t.okSoft, t.ok)
                                            mode == "audio" -> SecondaryButton(s.t("record.audio.enableMic"), { enableMic() })
                                            else -> SecondaryButton(s.t("record.enableCamera"), { enableCamera() })
                                        }
                                        PrimaryButton(if (mode == "audio") s.t("record.audio.record") else s.t("record.record"), ::startRecording)
                                        if (showUploadBtn) SecondaryButton(s.t("record.chooseFile"), { pickFile.launch(if (mode == "audio") "audio/*" else "video/*") })
                                    }
                                }
                                else -> {
                                    Dim(if (mode == "audio") s.t("record.audio.hint") else s.t("record.chooseVideoFile"))
                                    PrimaryButton(s.t("record.chooseFile"), { pickFile.launch(if (mode == "audio") "audio/*" else "video/*") })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MicMeter(level: Float, label: String) {
    val t = LocalTokens.current
    Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(t.bgElev2)) {
        Box(Modifier.fillMaxWidth(level.coerceIn(0f, 1f)).fillMaxHeight().background(t.ok))
    }
    Dim(label, size = 12)
}
