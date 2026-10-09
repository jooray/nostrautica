package today.cypherpunk.nostrautica.ui.screens.organizer

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.organizer.CoordinatorHelpers
import today.cypherpunk.nostrautica.domain.organizer.DiscoveredCoordinator
import today.cypherpunk.nostrautica.domain.organizer.GeneratedInvite
import today.cypherpunk.nostrautica.domain.organizer.Languages
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.EventConfig
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.qrBitmap
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.io.File
import java.text.DateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Small form pieces ───────────────────────────────────────────────────────

@Composable
fun SectionHead(text: String) {
    Text(text.uppercase(), color = LocalTokens.current.textDim, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.padding(top = 8.dp))
}

@Composable
fun FieldLabel(text: String, hint: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
        if (hint != null) Text(" $hint", color = LocalTokens.current.textDim, fontSize = 14.sp)
    }
}

@Composable
fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true, badge: String? = null) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) }, verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f, fill = false), fontSize = 15.sp)
        if (badge != null) { Text("  "); Pill(badge, LocalTokens.current.bgElev2, LocalTokens.current.textDim) }
        Text("", Modifier.weight(0.01f))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> ChoiceField(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    val t = LocalTokens.current
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { if (enabled) open = it }) {
        OutlinedTextField(
            value = options.firstOrNull { it.first == selected }?.second ?: selected.toString(),
            onValueChange = {}, readOnly = true, enabled = enabled, label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = t.bgElev) {
            options.forEach { (v, l) -> DropdownMenuItem(text = { Text(l) }, onClick = { onSelect(v); open = false }) }
        }
    }
}

@Composable
fun NumberField(value: String, onChange: (String) -> Unit, label: String, enabled: Boolean = true, decimal: Boolean = false, modifier: Modifier = Modifier) {
    Field(
        value, { v -> onChange(v.filter { it.isDigit() || (decimal && (it == '.' || it == ',')) }.replace(',', '.')) }, label,
        modifier = modifier, enabled = enabled,
        keyboard = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number),
    )
}

fun formatDateTime(sec: Long, locale: String): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, Locale.forLanguageTag(locale)).format(Date(sec * 1000))

/** A datetime-local equivalent: date dialog, then time dialog, in the phone's time zone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateTimeField(label: String, value: Long?, onChange: (Long?) -> Unit, error: String? = null, minSec: Long? = null) {
    val s = LocalStrings.current
    var stage by remember { mutableStateOf(0) } // 0 closed, 1 date, 2 time
    var pickedDayUtcMs by remember { mutableStateOf(0L) }
    PickerField(value?.let { formatDateTime(it, s.locale) } ?: "", label, error) { stage = 1 }
    if (stage == 1) {
        val initial = (value ?: minSec)?.let { localDayAsUtcMs(it) }
        val dp = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { stage = 0 },
            confirmButton = { TextButton({ dp.selectedDateMillis?.let { pickedDayUtcMs = it; stage = 2 } }) { Text(s.t("organizer.picker.ok")) } },
            dismissButton = {
                TextButton({ onChange(null); stage = 0 }) { Text(s.t("create.reset")) }
            },
        ) { DatePicker(dp) }
    }
    if (stage == 2) {
        val cal = Calendar.getInstance().apply { value?.let { timeInMillis = it * 1000 } }
        val tp = rememberTimePickerState(cal.get(Calendar.HOUR_OF_DAY), if (value == null) 0 else cal.get(Calendar.MINUTE))
        AlertDialog(
            onDismissRequest = { stage = 0 },
            confirmButton = { TextButton({ onChange(combine(pickedDayUtcMs, tp.hour, tp.minute)); stage = 0 }) { Text(s.t("organizer.picker.ok")) } },
            dismissButton = { TextButton({ stage = 0 }) { Text(s.t("create.imageUrl.cancel")) } },
            text = { TimePicker(tp) },
        )
    }
}

/** A read-only text field that opens a picker on tap (looks enabled, unlike a disabled field). */
@Composable
fun PickerField(value: String, label: String, error: String? = null, onOpen: () -> Unit) {
    val t = LocalTokens.current
    val source = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    LaunchedEffect(source) {
        source.interactions.collect { if (it is androidx.compose.foundation.interaction.PressInteraction.Release) onOpen() }
    }
    OutlinedTextField(
        value = value, onValueChange = {}, readOnly = true, label = { Text(label) }, isError = error != null,
        supportingText = error?.let { { Text(it) } }, interactionSource = source, singleLine = true,
        shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
        colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(unfocusedBorderColor = t.border, focusedBorderColor = t.accent, unfocusedContainerColor = t.bgElev, focusedContainerColor = t.bgElev),
    )
}


private fun localDayAsUtcMs(sec: Long): Long {
    val local = Calendar.getInstance().apply { timeInMillis = sec * 1000 }
    return Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
        clear(); set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH))
    }.timeInMillis
}

private fun combine(dayUtcMs: Long, hour: Int, minute: Int): Long {
    val day = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = dayUtcMs }
    return Calendar.getInstance().apply {
        clear(); set(day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH), hour, minute)
    }.timeInMillis / 1000
}

// ── Language picker (components/LanguagePicker.svelte) ─────────────────────

@Composable
fun LanguagePickerField(value: String, onChange: (String) -> Unit, label: String) {
    val s = LocalStrings.current
    val c = LocalContainer.current
    var open by remember { mutableStateOf(false) }
    val (options, pinned) = remember(s.locale) {
        val phone = androidx.core.os.LocaleListCompat.getAdjustedDefault().let { l -> (0 until l.size()).mapNotNull { l[it]?.language } }
        Languages.options(s.locale, phone, c.i18n.locales)
    }
    val shown = options.firstOrNull { it.code == value }?.label ?: value
    PickerField(shown, label) { open = true }
    if (open) {
        var q by remember { mutableStateOf("") }
        val filtered = remember(q) { Languages.filter(options, q) }
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {},
            dismissButton = { TextButton({ open = false }) { Text(s.t("common.close")) } },
            title = { Text(label) },
            text = {
                Column {
                    Field(q, { q = it }, label)
                    LazyColumn(Modifier.heightIn(max = 380.dp)) {
                        items(filtered.size) { i ->
                            val o = filtered[i]
                            if (q.isBlank() && i == pinned) HorizontalDivider()
                            Text(
                                o.label,
                                Modifier.fillMaxWidth().clickable { onChange(o.code); open = false }.padding(vertical = 10.dp),
                                fontWeight = if (o.code == value) FontWeight.Bold else FontWeight.Normal,
                                color = if (o.code == value) LocalTokens.current.accent else LocalTokens.current.text,
                            )
                        }
                    }
                }
            },
        )
    }
}

// ── Coordinator picker (components/CoordinatorPicker.svelte) ───────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CoordinatorCardView(co: DiscoveredCoordinator, selected: Boolean, actions: @Composable () -> Unit) {
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (selected) t.accentSoft else t.bgElev2).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            co.announce.picture?.let { AsyncImage(it, null, Modifier.size(40.dp).clip(RoundedCornerShape(10.dp))); Text("  ") }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(co.announce.name, fontWeight = FontWeight.SemiBold)
                    Text("  ")
                    Pill(CoordinatorHelpers.pricingLabel(co.announce), t.bgElev, t.textDim)
                }
                co.announce.about?.let { Dim(it, size = 13) }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (co.announce.features.matching) Pill(s.t("admin.coordinator.feat.matching"), t.bgElev, t.textDim)
            if (co.announce.features.talks) Pill(s.t("admin.coordinator.feat.talks"), t.bgElev, t.textDim)
            if (co.announce.features.chat.isNotEmpty()) Pill(s.t("admin.coordinator.feat.chat"), t.bgElev, t.textDim)
            co.announce.privacy?.filter { it.value != "private" }?.forEach { (role, _) -> Pill("$role: " + s.t("admin.coordinator.nonPrivate"), t.warnSoft, t.warn) }
        }
        Text(co.npub.take(20) + "…", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = t.textDim)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CoordinatorHelpers.httpsUrl(co.announce.termsUrl)?.let { url ->
                SmallButton(s.t("admin.coordinator.terms"), { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } })
            }
            actions()
        }
    }
}

/** Selection only: never publishes. Used before creation and in Settings. */
@Composable
fun CoordinatorPicker(selected: String?, onSelect: (String?) -> Unit, disabled: Boolean = false) {
    val s = LocalStrings.current
    val c = LocalContainer.current
    val t = LocalTokens.current
    var list by remember { mutableStateOf<List<DiscoveredCoordinator>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        list = c.organizer.cachedCoordinators()
        list = runCatching { c.organizer.fetchCoordinators() }.getOrDefault(list)
        loading = false
    }
    var paste by remember { mutableStateOf("") }
    var pasteError by remember { mutableStateOf<String?>(null) }
    var showPaste by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (loading && list.isEmpty()) Dim(s.t("admin.coordinator.discovering"))
        list.forEach { co ->
            CoordinatorCardView(co, selected == co.pubkey) {
                if (selected == co.pubkey) {
                    SmallButton(s.t("create.coordinator.clear"), { onSelect(null) }, enabled = !disabled)
                    Pill(s.t("create.coordinator.selected"), t.okSoft, t.ok)
                } else SmallButton(s.t("admin.coordinator.attachThis"), { onSelect(co.pubkey) }, enabled = !disabled, selected = true)
            }
        }
        if (list.isNotEmpty()) Dim(s.t("admin.coordinator.unverified"), size = 12)
        if (selected != null && list.none { it.pubkey == selected } && !loading) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Pill(s.t("create.coordinator.selected"), t.okSoft, t.ok)
                Text(selected.take(20) + "…", fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                SmallButton(s.t("create.coordinator.clear"), { onSelect(null) }, enabled = !disabled)
            }
        }
        Text(s.t("admin.coordinator.paste"), Modifier.clickable { showPaste = !showPaste }, color = t.textDim)
        if (showPaste) {
            Field(paste, { paste = it; pasteError = null }, s.t("admin.coordinator.placeholder"), enabled = !disabled, isError = pasteError != null, supporting = pasteError)
            SmallButton(s.t("create.coordinator.use"), {
                val pk = CoordinatorHelpers.parseKey(paste)
                if (pk == null) pasteError = s.t("create.coordinator.invalidKey") else { onSelect(pk); paste = "" }
            }, enabled = !disabled && paste.isNotBlank())
        }
    }
}

// ── Waiting for organizer custody (Admin/Settings "not organizer" card) ─────

/**
 * The receiving half of a co-organizer hand-off (organizer.ts pollForOrganizerGrant):
 * checks while visible only, backing off (4 s → 15 s → 60 s), with a manual check.
 */
@Composable
fun GrantWaitCard(coordinate: String, onGranted: () -> Unit) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    var checkedAt by remember { mutableStateOf<Long?>(null) }
    var checking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(coordinate, account) {
        if (account == null) return@LaunchedEffect
        val started = System.currentTimeMillis()
        while (true) {
            val elapsed = System.currentTimeMillis() - started
            delay(if (elapsed < 60_000) 4_000 else if (elapsed < 300_000) 15_000 else 60_000)
            val k = runCatching { c.organizer.checkForOrganizerGrant(coordinate) }.getOrNull()
            checkedAt = System.currentTimeMillis()
            if (k != null) { onGranted(); break }
        }
    }
    Card {
        Text(s.t("admin.notOrganizer.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.notOrganizer.body"))
        Text(s.t("admin.yourNpub"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        account?.npub?.let { npub ->
            Text(npub, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            SmallButton(s.t("admin.copyNpub"), { copyText(ctx, npub); today.cypherpunk.nostrautica.ui.shell.Toasts.show(s.t("admin.copied")) })
        }
        Dim("1. " + s.t("admin.grant.step1") + "\n2. " + s.t("admin.grant.step2") + "\n3. " + s.t("admin.grant.step3"))
        Dim(
            (if (account == null) s.t("admin.grant.waitingSigner") else s.t("admin.grant.waiting")) +
                (checkedAt?.let { " " + s.t("admin.grant.lastChecked", "time" to DateFormat.getTimeInstance(DateFormat.MEDIUM, Locale.forLanguageTag(s.locale)).format(Date(it))) } ?: ""),
        )
        SmallButton(if (checking) s.t("admin.grant.checkingNow") else s.t("admin.grant.checkNow"), {
            checking = true; error = null
            scope.launch {
                runCatching { c.organizer.checkForOrganizerGrant(coordinate) }
                    .onSuccess { checkedAt = System.currentTimeMillis(); if (it != null) onGranted() }
                    .onFailure { error = it.message }
                checking = false
            }
        }, enabled = !checking)
        error?.let { Text(it, color = LocalTokens.current.danger, fontSize = 13.sp) }
    }
}

// ── Platform helpers: clipboard, share sheet, files ─────────────────────────

fun copyText(ctx: Context, text: String) {
    ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("nostrautica", text))
}

fun shareText(ctx: Context, text: String, subject: String? = null) {
    val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    subject?.let { i.putExtra(Intent.EXTRA_SUBJECT, it) }
    runCatching { ctx.startActivity(Intent.createChooser(i, null)) }
}

/** Write to cache/exports/ and hand it to the share sheet through the app's FileProvider. */
fun shareFile(ctx: Context, name: String, mime: String, write: (File) -> Unit) {
    val dir = File(ctx.cacheDir, "exports").apply { mkdirs() }
    // Exports can hold live invite codes: keep only the newest file around.
    dir.listFiles()?.forEach { it.delete() }
    val f = File(dir, name)
    write(f)
    val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
    val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    runCatching { ctx.startActivity(Intent.createChooser(i, name)) }
}

/** The printable invite sheet (InviteSheet.svelte) as an A4 PDF: 2 × 4 QR cards per page. */
fun writeInviteSheetPdf(file: File, invites: List<GeneratedInvite>, eventTitle: String, scanHint: String) {
    val doc = PdfDocument()
    val pageW = 595; val pageH = 842; val cols = 2; val rows = 4
    val cellW = pageW / cols; val cellH = pageH / rows
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f; color = android.graphics.Color.BLACK }
    val bold = Paint(text).apply { isFakeBoldText = true; textSize = 13f }
    val dim = Paint(text).apply { color = android.graphics.Color.DKGRAY; textSize = 9f }
    invites.chunked(cols * rows).forEachIndexed { pi, chunk ->
        val page = doc.startPage(PdfDocument.PageInfo.Builder(pageW, pageH, pi + 1).create())
        val cv = page.canvas
        chunk.forEachIndexed { i, inv ->
            val x = (i % cols) * cellW + 20f
            val y = (i / cols) * cellH + 16f
            val qr = qrBitmap(inv.link, 512)
            cv.drawBitmap(qr, null, android.graphics.RectF(x, y, x + 142f, y + 142f), null)
            val tx = x + 150f
            cv.drawText(inv.label, tx, y + 20f, bold)
            eventTitle.chunked(22).take(3).forEachIndexed { li, line -> cv.drawText(line, tx, y + 40f + li * 14f, text) }
            scanHint.chunked(30).take(4).forEachIndexed { li, line -> cv.drawText(line, tx, y + 92f + li * 12f, dim) }
            qr.recycle()
        }
        doc.finishPage(page)
    }
    file.outputStream().use { doc.writeTo(it) }
    doc.close()
}

// ── Images: center-crop with preview (components/ImageCropper.svelte) ───────

object ImageCrop {
    /**
     * Read [uri], honour EXIF rotation, center-crop to [aspect] (w/h) and scale to
     * [outWidth] wide, as JPEG. The organizer sees the exact crop before upload.
     */
    fun centerCrop(ctx: Context, uri: Uri, aspect: Float, outWidth: Int, quality: Int = 88): ByteArray {
        val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= outWidth && bounds.outHeight / (sample * 2) >= outWidth / aspect) sample *= 2
        var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalArgumentException("That photo couldn't be processed. Please choose a different one.")
        val rot = runCatching { ExifInterface(bytes.inputStream()).rotationDegrees }.getOrDefault(0)
        if (rot != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rot.toFloat()) }, true)
        val srcAspect = bmp.width.toFloat() / bmp.height
        val (cw, ch) = if (srcAspect > aspect) ((bmp.height * aspect).toInt() to bmp.height) else (bmp.width to (bmp.width / aspect).toInt())
        val cropped = Bitmap.createBitmap(bmp, (bmp.width - cw) / 2, (bmp.height - ch) / 2, cw, ch)
        val w = minOf(outWidth, cw)
        val scaled = Bitmap.createScaledBitmap(cropped, w, (w / aspect).toInt(), true)
        return java.io.ByteArrayOutputStream().use { scaled.compress(Bitmap.CompressFormat.JPEG, quality, it); it.toByteArray() }
    }
}

/** Chat relays as the config states them (relays.ts chatRelaysOf). */
fun chatRelaysOf(cfg: EventConfig) = cfg.chatRelays
