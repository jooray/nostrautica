package today.cypherpunk.nostrautica.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.QrCode2
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import today.cypherpunk.nostrautica.i18n.LocalStrings
import today.cypherpunk.nostrautica.signer.Nip46Signer
import today.cypherpunk.nostrautica.signer.Nip55Signer
import today.cypherpunk.nostrautica.ui.LocalContainer
import today.cypherpunk.nostrautica.ui.LocalRouter
import today.cypherpunk.nostrautica.ui.components.Card
import today.cypherpunk.nostrautica.ui.components.Dim
import today.cypherpunk.nostrautica.ui.components.ErrorCard
import today.cypherpunk.nostrautica.ui.components.Field
import today.cypherpunk.nostrautica.ui.components.LinkButton
import today.cypherpunk.nostrautica.ui.components.Notice
import today.cypherpunk.nostrautica.ui.components.PrimaryButton
import today.cypherpunk.nostrautica.ui.components.QrCode
import today.cypherpunk.nostrautica.ui.components.ScreenTitle
import today.cypherpunk.nostrautica.ui.components.SecondaryButton
import today.cypherpunk.nostrautica.ui.components.SectionTitle
import today.cypherpunk.nostrautica.ui.nav.Route
import today.cypherpunk.nostrautica.ui.shell.GlobalScaffold
import today.cypherpunk.nostrautica.ui.shell.Page

/** What happens after a successful sign-in: grants scan, key unlock, then [then]. */
suspend fun afterLogin(c: today.cypherpunk.nostrautica.AppContainer) {
    val acct = c.session.account.value ?: return
    runCatching { c.eventKeys.unlockForLogin(acct.pubkey, acct.signer) }
    c.membership.bump()
}

/**
 * Sign in or create an identity (pages/Login.svelte + components/SignInOptions.svelte),
 * with the Android-native path first: a NIP-55 signer on this phone.
 */
@Composable
fun LoginScreen(nsec: String?, onDone: (() -> Unit)? = null, embedded: Boolean = false) {
    if (embedded) SignInBody(nsec, onDone) else GlobalScaffold { p -> Page(p) { item { SignInBody(nsec, onDone) } } }
}

@Composable
fun SignInBody(nsec: String?, onDone: (() -> Unit)?, showCreate: Boolean = true) {
    val c = LocalContainer.current
    val router = LocalRouter.current
    val s = LocalStrings.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by c.session.account.collectAsState()
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var paste by remember { mutableStateOf(nsec ?: "") }
    var passphrase by remember { mutableStateOf("") }
    var offer by remember { mutableStateOf<Nip46Signer.Companion.Offer?>(null) }
    var showQr by remember { mutableStateOf(false) }
    var waitJob by remember { mutableStateOf<Job?>(null) }
    val signers = remember { Nip55Signer.installedSigners(ctx) }
    // Nothing on this phone takes a nostrconnect:// link, so the only way in over
    // NIP-46 is a signer on another device: create the code and show its QR at once.
    val noSignerApp = remember {
        Intent(Intent.ACTION_VIEW, Uri.parse("nostrconnect://")).resolveActivity(ctx.packageManager) == null
    }
    var autoConnected by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current

    fun finish() {
        scope.launch { afterLogin(c) }
        if (onDone != null) onDone() else router.resetTo(Route.Home)
    }

    fun fail(e: Throwable) {
        error = e.message?.takeIf { it.isNotBlank() } ?: s.t("login.failed")
        busy = null
    }

    if (account != null && onDone == null) {
        Card { Text(s.t("login.alreadyLoggedIn")); PrimaryButton(s.t("login.continue"), { router.resetTo(Route.Home) }) }
        return
    }

    androidx.compose.foundation.layout.Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!embedded(onDone)) ScreenTitle(s.t("login.welcome"))
        error?.let { ErrorCard(it) }

        // 1. A signer app on this phone (NIP-55).
        Card {
            SectionTitle(s.t("signin.nip55"))
            if (signers.isEmpty()) Dim(s.t("signin.nip55.none"))
            for (app in signers) {
                PrimaryButton(s.t("signin.nip55.button", "app" to app.label), {
                    busy = "nip55"; error = null
                    scope.launch { runCatching { c.session.loginNip55(app.packageName) }.onSuccess { busy = null; finish() }.onFailure(::fail) }
                }, busy = busy == "nip55", icon = Icons.Outlined.Key)
            }
            if (signers.isNotEmpty()) Dim(s.t("signin.nip55.hint", "app" to signers.first().label), size = 13)
        }

        // 2. A remote signer (NIP-46 nostrconnect).
        Card {
            SectionTitle(s.t("signin.remote"))
            Dim(s.t("signin.remote.hint"))
            val o = offer
            val connect = {
                error = null
                val fresh = Nip46Signer.nostrConnectOffer()
                offer = fresh
                waitJob?.cancel()
                waitJob = scope.launch {
                    runCatching { Nip46Signer.awaitNostrConnect(c.pool, fresh) }
                        .onSuccess { c.session.adoptNip46(it); offer = null; finish() }
                        .onFailure { if (it !is kotlinx.coroutines.CancellationException) { offer = null; fail(it) } }
                }
            }
            if (noSignerApp && o == null && !autoConnected) {
                LaunchedEffect(Unit) { autoConnected = true; showQr = true; connect() }
            }
            if (o == null) {
                SecondaryButton(s.t("signin.remote.connect"), { connect() })
            } else {
                Dim(s.t("signin.remote.waiting"))
                if (!noSignerApp) {
                    PrimaryButton(s.t("signin.remote.openSigner"), {
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(o.uri))) }
                    })
                }
                if (showQr) {
                    Dim(s.t("signin.remote.scan"))
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { QrCode(o.uri) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        LinkButton(s.t("signin.remote.copy"), { clipboard.setText(AnnotatedString(o.uri)) })
                    }
                } else {
                    LinkButton(s.t("signin.remote.showQr"), { showQr = true })
                }
                Dim(s.t("signin.remote.staleHint"), size = 13)
                LinkButton(s.t("signin.remote.cancel"), { waitJob?.cancel(); offer = null; showQr = false })
            }
        }

        // 3. Paste a key or a bunker:// link.
        Card {
            SectionTitle(s.t("signin.paste"))
            Field(paste, { paste = it.trim() }, s.t("signin.paste"), placeholder = s.t("signin.paste.placeholder"),
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Password), visual = PasswordVisualTransformation())
            if (paste.startsWith("ncryptsec1")) {
                Field(passphrase, { passphrase = it }, s.t("signin.paste.passphrase"), visual = PasswordVisualTransformation())
            }
            if (paste.startsWith("bunker://")) {
                PrimaryButton(if (busy == "bunker") s.t("signin.paste.contacting") else s.t("signin.paste.connectBunker"), {
                    busy = "bunker"; error = null
                    scope.launch { runCatching { Nip46Signer.connectBunker(c.pool, paste) }.onSuccess { c.session.adoptNip46(it); busy = null; finish() }.onFailure(::fail) }
                }, busy = busy == "bunker")
            } else {
                SecondaryButton(s.t("signin.paste.import"), {
                    error = null
                    busy = "import"
                    scope.launch {
                        // NIP-49 scrypt takes a second or more: never on the main thread.
                        val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                            try { Result.success(c.session.importKey(paste, passphrase.ifEmpty { null })) }
                            catch (e: OutOfMemoryError) { Result.failure(IllegalStateException(s.t("signin.paste.tooStrong"))) }
                            catch (e: Exception) { Result.failure(e) }
                        }
                        busy = null
                        r.onSuccess { finish() }.onFailure { e ->
                            error = when {
                                e is IllegalStateException && e.message == s.t("signin.paste.tooStrong") -> e.message
                                paste.startsWith("ncryptsec1") && e.message == "wrong password" -> s.t("signin.paste.wrongPassphrase")
                                else -> s.t("signin.paste.invalid")
                            }
                        }
                    }
                }, enabled = paste.isNotEmpty(), busy = busy == "import")
            }
            Dim(s.t("signin.paste.saferHint"), size = 13)
        }

        // 4. A new identity, for people who don't use Nostr (yet).
        if (showCreate) {
            Card {
                SectionTitle(s.t("login.createHeading"))
                Dim(s.t("login.createSub"))
                Field(name, { name = it }, s.t("login.yourName"), placeholder = s.t("login.namePlaceholder"))
                PrimaryButton(if (busy == "create") s.t("login.creating") else s.t("login.createMyIdentity"), {
                    busy = "create"; error = null
                    c.session.createLocalKey()
                    scope.launch {
                        runCatching { c.social.onboard(name.trim()) }
                        busy = null
                        finish()
                    }
                }, enabled = name.isNotBlank(), busy = busy == "create")
            }
        }

        Card {
            SectionTitle(s.t("signin.trouble"))
            Dim(s.t("signin.trouble.wrongApp"), size = 13)
            Dim(s.t("signin.trouble.bunker"), size = 13)
            Dim(s.t("signin.trouble.primal"), size = 13)
        }
    }
}

private fun embedded(onDone: (() -> Unit)?) = onDone != null
