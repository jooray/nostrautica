package today.cypherpunk.nostrautica.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.BuildConfig
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.Nip49
import today.cypherpunk.nostrautica.protocol.Wire
import today.cypherpunk.nostrautica.signer.Session
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Avatar
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.components.SmallButton
import today.cypherpunk.nostrautica.ui.components.SoftCard
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.EventScaffold
import today.cypherpunk.nostrautica.ui.shell.GlobalScaffold
import today.cypherpunk.nostrautica.ui.shell.LocalEvent
import today.cypherpunk.nostrautica.ui.shell.MenuRow
import today.cypherpunk.nostrautica.ui.shell.Page
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens

/** Log out the PWA's way: lock event keys with the signer, drop this owner's data. */
suspend fun logout(c: AppContainer) {
    val acct = c.session.account.value ?: return
    runCatching { c.eventKeys.lockForLogout(acct.pubkey, acct.signer) }
    runCatching { c.nostr.discardOwner(acct.pubkey) }
    runCatching { c.cache.dropScope(acct.pubkey) }
    c.accounts.forget(acct.pubkey)
    c.session.logout()
    c.membership.bump()
}

@Composable
fun MeScreen() {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val account by c.session.account.collectAsState()
    val needsBackup by c.session.needsBackup.collectAsState()
    var keyLoss by remember { mutableStateOf(false) }
    var unsent by remember { mutableStateOf(0) }
    val ctx = LocalContext.current

    GlobalScaffold { p ->
        Page(p) {
            val a = account
            if (a == null) {
                item { Card { Text(s.t("me.notLoggedIn")); PrimaryButton(s.t("me.login"), { router.go(Route.Login()) }) } }
                return@Page
            }
            item { ScreenTitle(if (needsBackup) s.t("me.title.new") else s.t("me.title.profile")) }
            if (needsBackup) item { Dim(s.t("me.new.body"), size = 15) }
            item {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        val profile by remember(a.pubkey) { c.profiles.observe(listOf(a.pubkey)) }.collectAsState(emptyMap())
                        val me = profile[a.pubkey]
                        Avatar(a.pubkey, me?.name, me?.picture, 52.dp)
                        Column { Text(me?.name ?: "", fontWeight = FontWeight.SemiBold, fontSize = 18.sp) }
                    }
                    Text(s.t("me.handle"), fontWeight = FontWeight.SemiBold)
                    Dim(s.t("me.handle.body"))
                    SelectionContainer { Text(a.npub, fontFamily = FontFamily.Monospace, fontSize = 13.sp) }
                    SmallButton(s.t("me.copyNpub"), { clipboard.setText(AnnotatedString(a.npub)); Toasts.show(s.t("me.copied")) })
                    Dim(s.t("me.signedInVia", "method" to methodLabel(a.method)) + if (a.method != Session.Method.LOCAL) " " + s.t("me.keyInSigner") else "")
                }
            }
            if (a.method == Session.Method.LOCAL) item {
                Card {
                    SectionTitle(if (needsBackup) s.t("me.takeAnywhere") else s.t("me.backupKey"))
                    if (needsBackup) Dim(s.t("me.takeAnywhere.body"))
                    BackupCard()
                    if (needsBackup) for ((name, url) in CLIENTS) SecondaryButton("$name ↗", { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) })
                }
            }
            item {
                Card {
                    if (keyLoss) {
                        SoftCard(color = t.dangerSoft) {
                            Text(s.t("me.logout.keyLoss.title"), fontWeight = FontWeight.SemiBold)
                            Text(s.t("me.logout.keyLoss.body"))
                            if (unsent > 0) Dim(s.tp("me.logout.warnUnsent", unsent))
                        }
                        Text(s.t("me.logout.keyLoss.backup"), fontWeight = FontWeight.SemiBold)
                        BackupCard()
                        SecondaryButton(s.t("me.logout.cancel"), { keyLoss = false })
                        SecondaryButton(s.t("me.logout.keyLoss.confirm"), { scope.launch { logout(c); router.resetTo(Route.Home) } }, danger = true)
                    } else {
                        SecondaryButton(s.t("me.logout"), {
                            scope.launch {
                                unsent = c.nostr.observeOutbox(a.pubkey).first().size
                                if (a.method == Session.Method.LOCAL && needsBackup || unsent > 0) keyLoss = true
                                else { logout(c); router.resetTo(Route.Home) }
                            }
                        }, danger = true)
                    }
                }
            }
        }
    }
}

private val CLIENTS = listOf(
    "Primal" to "https://primal.net",
    "Damus" to "https://damus.io",
    "Amethyst" to "https://github.com/vitorpamplona/amethyst",
    "Yakihonne" to "https://yakihonne.com",
)

private fun methodLabel(m: Session.Method) = when (m) { Session.Method.LOCAL -> "local"; Session.Method.NIP55 -> "nip55"; Session.Method.NIP46 -> "nip46" }

/** components/BackupCard.svelte: copy the nsec, or a password-protected ncryptsec. */
@Composable
fun BackupCard() {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var stage by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(false) }
    var pass by remember { mutableStateOf("") }
    var encrypted by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val sk = remember(c.session.account.value) { c.session.exportSecret() }
    if (sk == null) { Dim(s.t("backup.noKey")); return }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Dim(s.t("backup.warning.a") + " " + s.t("backup.warning.keepSecret") + s.t("backup.warning.b"))
        PrimaryButton(s.t("backup.copyKey"), { clipboard.setText(AnnotatedString(Nip19.nsec(sk))); stage = "copied" })
        if (stage == "copied") {
            Dim(s.t("backup.stage.copied"))
            SecondaryButton(s.t("backup.stage.iSavedIt"), { c.session.markBackedUp(); stage = "saved"; Toasts.show(s.t("backup.stage.confirmed")) })
        }
        if (!more) SmallButton(s.t("backup.more"), { more = true })
        else {
            Text(s.t("backup.file.title"), fontWeight = FontWeight.SemiBold)
            Field(pass, { pass = it }, s.t("backup.file.placeholder"), visual = PasswordVisualTransformation())
            SecondaryButton(s.t("backup.file.encrypt"), {
                busy = true
                scope.launch {
                    encrypted = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { Nip49.encrypt(sk, pass) }
                    busy = false
                }
            }, enabled = pass.length >= 4, busy = busy)
            encrypted?.let { e ->
                SelectionContainer { Text(e, fontFamily = FontFamily.Monospace, fontSize = 12.sp) }
                SmallButton(s.t("backup.file.copy"), { clipboard.setText(AnnotatedString(e)); c.session.markBackedUp() })
            }
        }
    }
}

@Composable
fun SettingsScreen() {
    val c = LocalContainer.current
    val s = LocalStrings.current
    val theme by c.prefs.theme.collectAsState()
    val ext by c.prefs.externalImages.collectAsState()
    GlobalScaffold { p ->
        Page(p) {
            item { ScreenTitle(s.t("settings.title")) }
            item {
                Card {
                    SectionTitle(s.t("settings.theme"))
                    for (opt in listOf("system", "light", "dark")) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(theme == opt, { c.prefs.setTheme(opt) })
                            Text(s.t("settings.theme.$opt"))
                        }
                    }
                }
            }
            item {
                Card {
                    SectionTitle(s.t("settings.language"))
                    for (l in c.i18n.locales) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(s.locale == l, { c.i18n.set(l) })
                            Text(c.i18n.localeNames[l] ?: l)
                        }
                    }
                }
            }
            item {
                Card {
                    SectionTitle(s.t("settings.privacy"))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.t("settings.externalImages"), Modifier.weight(1f))
                        Switch(ext, { c.prefs.setExternalImages(it) })
                    }
                    Dim(s.t("settings.externalImages.hint"), size = 13)
                }
            }
            item {
                Card {
                    SectionTitle(s.t("settings.about"))
                    Dim(s.t("settings.about.hint"), size = 13)
                    Text("${s.t("settings.about.release")}: v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                    Text("${s.t("settings.about.protocol")}: v${Wire.PROTOCOL_VERSION}")
                    Dim(s.t("app.android.updateHint"), size = 13)
                }
            }
        }
    }
}

/** pages/EventMore.svelte + components/more-rows.ts. */
@Composable
fun EventMoreScreen(naddr: String) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val clipboard = LocalClipboardManager.current
    val account by c.session.account.collectAsState()
    EventScaffold(naddr) { p ->
        val ev = LocalEvent.current
        Page(p) {
            item { ScreenTitle(s.t("nav.more")) }
            item {
                Card {
                    SectionTitle(s.t("more.identity"))
                    val a = account
                    if (a == null) PrimaryButton(s.t("nav.login"), { router.go(Route.Login()) })
                    else SmallButton(s.t("more.copyNpub"), { clipboard.setText(AnnotatedString(a.npub)); Toasts.show(s.t("more.copied")) })
                }
            }
            if (ev.isMember) item { MenuRow(Icons.Outlined.Person, s.t("profile.mine.title")) { router.go(Route.MyProfile(naddr)) } }
            if (account != null) item { MenuRow(Icons.Outlined.Chat, s.t("nav.messages")) { router.go(Route.Dm) } }
            if (ev.isOrganizer) item { MenuRow(Icons.Outlined.AdminPanelSettings, s.t("more.manageEvent")) { router.go(Route.Admin(naddr)) } }
            item { MenuRow(Icons.Outlined.Event, s.t("more.allEvents")) { router.resetTo(Route.Home) } }
            item { MenuRow(Icons.Outlined.Add, s.t("more.createEvent")) { router.go(Route.Create) } }
            item { MenuRow(Icons.Outlined.Tune, s.t("nav.settings")) { router.go(Route.Settings) } }
        }
    }
}

