package today.cypherpunk.nostrautica.ui.screens.organizer

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.domain.organizer.Organizer
import today.cypherpunk.nostrautica.domain.organizer.organizer
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Bytes
import today.cypherpunk.nostrautica.protocol.EventPage
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.components.Body
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Serializable
private data class PostDraft(val title: String = "", val summary: String = "", val image: String = "", val content: String = "")

/**
 * AdminCommunicate.svelte + PostEditor.svelte: compose or edit a public 30023 update
 * or a members-only 31607. Visibility is fixed once a post exists (§7.4); an unsent
 * new post is kept as a draft.
 */
@Composable
fun CommunicateCard(st: AdminState) {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val org = c.organizer
    val draftId = "post:${st.coordinate}"
    var title by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var image by remember { mutableStateOf("") }
    var content by remember { mutableStateOf("") }
    var members by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Organizer.Post?>(null) }
    var busy by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf(false) }
    var uploading by remember { mutableStateOf(false) }
    var uploadError by remember { mutableStateOf<String?>(null) }
    var restored by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    val json = remember { kotlinx.serialization.json.Json { ignoreUnknownKeys = true } }

    LaunchedEffect(Unit) {
        org.loadDraft(draftId)?.let { runCatching { json.decodeFromString(PostDraft.serializer(), it) }.getOrNull() }?.let { d ->
            if (d.title.isNotBlank() || d.content.isNotBlank()) { title = d.title; summary = d.summary; image = d.image; content = d.content; restored = true }
        }
        loaded = true
    }
    LaunchedEffect(title, summary, image, content, editing, loaded) {
        if (!loaded || editing != null) return@LaunchedEffect
        delay(600)
        val empty = title.isBlank() && summary.isBlank() && image.isBlank() && content.isBlank()
        org.saveDraft(draftId, if (empty) "" else json.encodeToString(PostDraft.serializer(), PostDraft(title, summary, image, content)))
    }
    fun reset() { editing = null; title = ""; summary = ""; image = ""; content = ""; members = false; preview = false }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val a = c.session.account.value ?: return@rememberLauncherForActivityResult
        scope.launch {
            uploading = true; uploadError = null
            runCatching {
                val bytes = withContext(Dispatchers.IO) { ImageCrop.centerCrop(ctx, uri, 1200f / 630f, 1200) }
                image = org.blossom.uploadPublicImage(a.signer, bytes)
            }.onFailure { uploadError = it.message }
            uploading = false
        }
    }

    val bytes = Bytes.utf8Length(content)
    val max = EventPage.MAX_MEMBERS_POST_MARKDOWN_BYTES
    val over = members && bytes > max
    val canSubmit = !busy && !over && title.isNotBlank() && content.isNotBlank()

    Card {
        Text(s.t("admin.posts.title"), fontWeight = FontWeight.SemiBold)
        Dim(s.t("admin.posts.body"), size = 13)
        if (restored && editing == null) Row(verticalAlignment = Alignment.CenterVertically) {
            Dim(s.t("draft.restored"), Modifier.weight(1f))
            SmallButton(s.t("draft.discard"), { reset(); restored = false; scope.launch { org.saveDraft(draftId, "") } })
        }
        Field(title, { title = it }, s.t("post.editor.titlePlaceholder"))
        Field(summary, { summary = it }, s.t("post.editor.summaryPlaceholder"))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(image, { image = it }, s.t("post.editor.imagePlaceholder"), modifier = Modifier.weight(1f))
            SmallButton(if (uploading) s.t("post.editor.uploading") else s.t("post.editor.upload"), {
                picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }, enabled = !uploading)
        }
        if (image.isNotBlank()) AsyncImage(image, s.t("post.editor.imagePreview"), Modifier.fillMaxWidth().aspectRatio(1200f / 630f).clip(RoundedCornerShape(10.dp)), contentScale = ContentScale.Crop)
        uploadError?.let { Text(it, color = t.danger, fontSize = 13.sp) }
        Text(s.t("post.editor.visibility"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        RadioLine(s.t("post.editor.public") + " · " + s.t("post.editor.public.hint"), !members, enabled = editing == null) { members = false }
        RadioLine(s.t("post.editor.members") + " · " + s.t("post.editor.members.hint"), members, enabled = editing == null) { members = true }
        if (editing != null) Dim(s.t("post.editor.visibilityLocked"), size = 12)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallButton(s.t("post.editor.write"), { preview = false }, selected = !preview)
            SmallButton(s.t("post.editor.preview"), { preview = true }, selected = preview)
        }
        if (preview) {
            if (content.isBlank()) Dim(s.t("post.editor.nothingToPreview")) else Body(content)
        } else Field(content, { content = it }, s.t("post.editor.contentPlaceholder"), singleLine = false, minLines = 6)
        if (members) Text(s.t("post.editor.byteCount", "used" to bytes, "max" to max), fontSize = 12.sp, color = if (over) t.danger else t.textDim)
        else Dim(s.tp("post.editor.bytes", bytes), size = 12)
        if (over) Text(s.t("post.editor.tooLong", "max" to max, "over" to (bytes - max)), color = t.danger, fontSize = 13.sp)
        PrimaryButton(
            if (busy) s.t("post.editor.publishing") else if (editing != null) s.t("post.editor.saveEdit") else s.t("post.editor.publish"),
            {
                busy = true
                scope.launch {
                    try {
                        val e = editing
                        val input = Organizer.PostInput(e?.d, title.trim(), summary.trim().ifEmpty { null }, image.trim().ifEmpty { null }, content, e?.publishedAt)
                        val ok = if (members) org.publishMembersPost(st.ctx, input, if (e != null) e.author else st.me) else org.publishUpdate(st.ctx, input)
                        if (ok) {
                            reset(); restored = false; org.saveDraft(draftId, "")
                            Toasts.show(s.t("op.postPublished"))
                        } else Toasts.show(s.t("op.postQueued"))
                        st.refreshPosts()
                    } catch (e: Exception) {
                        st.error = e.message ?: e.toString()
                    } finally { busy = false }
                }
            },
            enabled = canSubmit, busy = busy,
        )
        if (editing != null) SmallButton(s.t("post.editor.cancelEdit"), { reset() })
        val fmt = DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(s.locale))
        st.posts.forEach { p ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text((if (p.locked) s.t("post.locked.title") else p.title) + " · " + fmt.format(Date(p.publishedAt * 1000)), Modifier.weight(1f), maxLines = 1, fontSize = 14.sp)
                if (p.membersOnly) Pill(s.t("post.membersBadge"), t.bgElev2, t.textDim)
                if (!p.locked) SmallButton(s.t("admin.posts.edit"), {
                    editing = p; title = p.title; summary = p.summary ?: ""; image = p.image ?: ""; content = p.content; members = p.membersOnly; preview = false
                })
            }
        }
    }
}
