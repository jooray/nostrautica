package today.cypherpunk.nostrautica.ui.screens.join

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.domain.join.AuthoredFields
import today.cypherpunk.nostrautica.domain.join.AuthoredProfile
import today.cypherpunk.nostrautica.domain.join.introMedia
import today.cypherpunk.nostrautica.domain.join.joinFlow
import today.cypherpunk.nostrautica.domain.media.Outcome
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.AiProfile
import today.cypherpunk.nostrautica.protocol.AiProfileOverride
import today.cypherpunk.nostrautica.protocol.DirectoryEntryContent
import today.cypherpunk.nostrautica.protocol.Limits
import today.cypherpunk.nostrautica.protocol.MediaDescriptor
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Loading
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

private fun aiField(f: String, ai: AiProfile?): String = when {
    ai == null -> ""
    f == "summary" -> ai.summary
    else -> (when (f) { "skills" -> ai.skills; "interests" -> ai.interests; "offers" -> ai.offers; else -> ai.seeks }).joinToString("\n")
}

private fun lines(s: String) = s.split('\n').map { it.trim() }.filter { it.isNotEmpty() }

/**
 * pages/MyProfile.svelte: how this attendee appears to others — "You wrote" (edit
 * → a new 21601 revision, media preserved) and "Generated from your intro"
 * (correct / hide fields / hide all → a 21608 the coordinator re-applies).
 */
@Composable
fun MyProfileScreen(naddr: String) {
    val router = LocalRouter.current
    val s = LocalStrings.current
    EventScaffold(naddr, back = s.t("nav.back") to { if (!router.back()) router.switchTo(Route.EventMore(naddr)) }) { p ->
        val ev = LocalEvent.current
        val c = LocalContainer.current
        val t = LocalTokens.current
        val scope = rememberCoroutineScope()
        val account by c.session.account.collectAsState()
        val draftKey = "draft:authprofile:${ev.coordinate}"

        var entry by remember { mutableStateOf<DirectoryEntryContent?>(null) }
        var loading by remember { mutableStateOf(true) }
        var error by remember { mutableStateOf<String?>(null) }

        var editing by remember { mutableStateOf(false) }
        var authored by remember { mutableStateOf(AuthoredFields()) }
        var baseline by remember { mutableStateOf(AuthoredFields()) }
        var authoredMedia by remember { mutableStateOf<List<MediaDescriptor>>(emptyList()) }
        var authoredBusy by remember { mutableStateOf(false) }
        var authoredSaved by remember { mutableStateOf(false) }
        var authoredQueued by remember { mutableStateOf(false) }
        var authoredError by remember { mutableStateOf<String?>(null) }
        var dropped by remember { mutableStateOf<List<String>>(emptyList()) }
        var draftRestored by remember { mutableStateOf(false) }
        var nostrAbout by remember { mutableStateOf("") }
        val dirty = AuthoredProfile.changed(authored, baseline)

        val values = remember { mutableStateMapOf<String, String>() }
        val initial = remember { mutableStateMapOf<String, String>() }
        val hide = remember { mutableStateMapOf<String, Boolean>() }
        var hideAll by remember { mutableStateOf(false) }
        var report by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var saved by remember { mutableStateOf(false) }
        var saveQueued by remember { mutableStateOf(false) }

        fun loadFromEntry(e: DirectoryEntryContent?) {
            for (f in AiProfile.FIELDS) {
                val v = aiField(f, e?.aiProfile)
                values[f] = v
                initial[f] = v
                hide[f] = false
            }
            hideAll = false
        }

        LaunchedEffect(account?.pubkey) {
            val a = account ?: run { router.go(Route.Login()); return@LaunchedEffect }
            // Cache first; only a POSITIVE fresh answer replaces it (a republish gap must not blank it).
            c.members.cachedDirectory(a.pubkey, ev.coordinate).firstOrNull { it.pubkey == a.pubkey }?.let { entry = it; loadFromEntry(it) }
            loading = false
            runCatching { c.introMedia.ownDirectoryEntry(a.signer, ev.ctx, refresh = true) }.getOrNull()?.let { entry = it; loadFromEntry(it) }
        }

        // Persist unsent authored edits as they're typed (U9).
        LaunchedEffect(authored, editing) {
            val a = account ?: return@LaunchedEffect
            if (!editing) return@LaunchedEffect
            delay(400)
            if (AuthoredProfile.changed(authored, baseline)) c.cache.put(a.pubkey, draftKey, AuthoredFields.serializer(), authored)
            else c.cache.delete(a.pubkey, draftKey)
        }

        fun openEditor() {
            val a = account ?: return
            authoredError = null
            authoredSaved = false
            scope.launch {
                var profile = entry?.profile
                var intro = entry?.introText
                var media = entry?.media ?: emptyList()
                runCatching {
                    val self = c.introMedia.loadSelfCopy(a.signer, ev.ctx, c.accounts.blindingKey())
                    if (self?.profile != null) profile = self.profile
                    if (self?.introText != null) intro = self.introText
                    self?.media?.takeIf { it.isNotEmpty() }?.let { media = it }
                }
                val f = AuthoredProfile.fieldsFrom(profile, intro)
                authored = f
                baseline = f
                authoredMedia = media
                c.cache.get(a.pubkey, draftKey, AuthoredFields.serializer())?.takeIf { AuthoredProfile.changed(it, f) }?.let { authored = it; draftRestored = true }
                editing = true
                runCatching { c.profiles.refresh(listOf(a.pubkey)) }
                nostrAbout = c.profiles.local(a.pubkey)?.about.orEmpty()
            }
        }

        fun saveAuthored() {
            val a = account ?: return
            authoredBusy = true; authoredError = null; authoredSaved = false; authoredQueued = false; dropped = emptyList()
            scope.launch {
                try {
                    val bk = c.accounts.blindingKey()
                    val built = AuthoredProfile.build(authored, authoredMedia)
                    val n = AuthoredProfile.normalize(built.profile)
                    dropped = n.dropped
                    val out = c.introMedia.submitProfileAndMedia(a.signer, ev.ctx, n.profile, built.media, bk, built.introText)
                    authoredSaved = true
                    authoredQueued = out.aggregate != Outcome.PUBLISHED
                    baseline = authored
                    c.cache.delete(a.pubkey, draftKey)
                    draftRestored = false
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    authoredError = errorText(e, s)
                } finally { authoredBusy = false }
            }
        }

        fun saveCorrection() {
            val a = account ?: return
            busy = true; error = null; saved = false; saveQueued = false
            scope.launch {
                try {
                    val out = if (hideAll) c.joinFlow.submitCorrection(a.signer, ev.ctx, hidden = true, report = report.trim().ifEmpty { null })
                    else {
                        val changed = AiProfile.FIELDS.filter { hide[it] != true && values[it] != initial[it] }
                        fun list(f: String) = if (f in changed) lines(values[f].orEmpty()) else null
                        val overrides = AiProfileOverride(
                            summary = if ("summary" in changed) values["summary"] else null,
                            skills = list("skills"), interests = list("interests"), offers = list("offers"), seeks = list("seeks"),
                        ).takeIf { changed.isNotEmpty() }
                        val hidden = AiProfile.FIELDS.filter { hide[it] == true }.ifEmpty { null }
                        c.joinFlow.submitCorrection(a.signer, ev.ctx, overrides = overrides, hiddenFields = hidden, report = report.trim().ifEmpty { null })
                    }
                    saved = true
                    saveQueued = out != Outcome.PUBLISHED
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    error = errorText(e, s)
                } finally { busy = false }
            }
        }

        Page(p) {
            item { ScreenTitle(s.t("profile.mine.title")) }
            item { Dim(s.t("profile.mine.intro")) }
            error?.let { item { ErrorCard(it) } }
            if (loading) { item { Loading(s.t("app.loading")) }; return@Page }

            item {
                Card {
                    Text(s.t("profile.authored.title"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("profile.authored.hint"), size = 13)
                    if (!editing) {
                        entry?.profile?.about?.takeIf { it.isNotBlank() }?.let { Text(it) }
                        entry?.profile?.skills?.distinct()?.takeIf { it.isNotEmpty() }?.let { skills ->
                            androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                for (sk in skills) Pill(sk, t.bgElev2, t.text)
                            }
                        }
                        entry?.profile?.lookingFor?.takeIf { it.isNotBlank() }?.let { Dim(s.t("attendee.lookingFor", "value" to it)) }
                        entry?.introText?.takeIf { it.isNotBlank() }?.let { Dim(it) }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SmallButton(s.t("profile.authored.edit"), ::openEditor)
                            SmallButton(s.t("profile.authored.rerecord"), { router.go(Route.Record(ev.naddr)) })
                        }
                    } else {
                        authoredError?.let { ErrorCard(it) }
                        if (draftRestored) Row(verticalAlignment = Alignment.CenterVertically) {
                            Dim(s.t("draft.restored"), Modifier.weight(1f), size = 13)
                            LinkButton(s.t("draft.discard"), {
                                authored = baseline; draftRestored = false
                                account?.let { a -> scope.launch { c.cache.delete(a.pubkey, draftKey) } }
                            })
                        }
                        Field(authored.about, { if (it.length <= Limits.MAX_ABOUT) authored = authored.copy(about = it) }, s.t("profile.authored.about"), singleLine = false, minLines = 3)
                        if (nostrAbout.isNotBlank() && nostrAbout.trim() != authored.about.trim()) {
                            Dim(s.t("profile.authored.nostrDiffers"), size = 13)
                            Text(nostrAbout, color = t.textDim, fontStyle = FontStyle.Italic)
                            SmallButton(s.t("profile.authored.useNostr"), { authored = authored.copy(about = nostrAbout) })
                        }
                        Field(authored.skills, { authored = authored.copy(skills = it) }, s.t("profile.authored.skills"), placeholder = s.t("profile.authored.skills.placeholder"))
                        Field(authored.lookingFor, { if (it.length <= Limits.MAX_LOOKING_FOR) authored = authored.copy(lookingFor = it) }, s.t("profile.authored.lookingFor"))
                        Field(authored.links, { authored = authored.copy(links = it) }, s.t("profile.authored.links"), placeholder = s.t("profile.authored.links.placeholder"), singleLine = false, minLines = 2)
                        Field(authored.introText, { if (it.length <= Limits.MAX_INTRO_TEXT) authored = authored.copy(introText = it) }, s.t("profile.authored.introText"),
                            singleLine = false, minLines = 3, supporting = s.t("profile.authored.introText.hint"))
                        if (dropped.isNotEmpty()) Dim(s.t("profile.authored.links.dropped", "links" to dropped.joinToString(", ")), size = 13)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            PrimaryButton(if (authoredBusy) s.t("profile.saving") else s.t("profile.save"), ::saveAuthored, Modifier.weight(1f), enabled = dirty, busy = authoredBusy)
                            LinkButton(s.t("profile.authored.cancel"), { editing = false })
                        }
                        if (authoredSaved) {
                            Pill(s.t("profile.saved"), t.okSoft, t.ok)
                            Dim(if (authoredQueued) s.t("sync.queued") else s.t("profile.authored.saved.hint"), size = 13)
                        }
                    }
                }
            }

            item {
                Card {
                    Text(s.t("profile.generated.title"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("profile.generated.hint"), size = 13)
                    if (entry?.aiProfile == null) Dim(s.t("profile.generated.none"))
                    CheckRow(hideAll, { hideAll = it }, s.t("profile.hide.all"))
                    if (!hideAll && entry?.aiProfile != null) {
                        for (f in AiProfile.FIELDS) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(s.t("profile.field.$f"), Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                CheckRow(hide[f] == true, { hide[f] = it }, s.t("profile.field.hide"))
                            }
                            if (hide[f] != true) {
                                Field(values[f].orEmpty(), { values[f] = it }, s.t("profile.field.$f"), singleLine = false, minLines = if (f == "summary") 4 else 3,
                                    placeholder = if (f != "summary") s.t("profile.field.listPlaceholder") else null,
                                    supporting = if (f != "summary") s.t("profile.field.listHint") else null)
                            } else Dim(s.t("profile.field.hidden"), size = 13)
                        }
                    }
                    Field(report, { if (it.length <= Limits.MAX_INTRO_TEXT) report = it }, s.t("profile.report.title"), placeholder = s.t("profile.report.placeholder"), singleLine = false, minLines = 2)
                    PrimaryButton(if (busy) s.t("profile.saving") else s.t("profile.save"), ::saveCorrection, busy = busy)
                    if (saved) {
                        Pill(s.t("profile.saved"), t.okSoft, t.ok)
                        Dim(if (saveQueued) s.t("sync.queued") else s.t("profile.saved.hint"), size = 13)
                    }
                }
            }
        }
    }
}
