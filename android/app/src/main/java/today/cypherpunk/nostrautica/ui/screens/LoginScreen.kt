package today.cypherpunk.nostrautica.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import today.cypherpunk.nostrautica.domain.join.introMedia
import today.cypherpunk.nostrautica.domain.media.PublicImages
import today.cypherpunk.nostrautica.ui.components.Pill
import today.cypherpunk.nostrautica.ui.screens.join.errorText
import today.cypherpunk.nostrautica.ui.shell.Toasts
import today.cypherpunk.nostrautica.ui.theme.LocalTokens
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
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.Secp
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
    var newPhoto by remember { mutableStateOf<Uri?>(null) }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) newPhoto = uri }
    val t = LocalTokens.current
    // Never pre-fill the (masked) paste field from a link: any app or web page can
    // open `…#/login?nsec=`, and one tap on Import would sign the user in as the
    // sender's identity (SB-22). A login link is shown as what it is, with the
    // account it signs in as, and needs its own explicit confirmation.
    var paste by remember { mutableStateOf("") }
    var linkKey by remember { mutableStateOf(nsec?.trim()?.takeIf { it.startsWith("nsec1") }) }
    val linkNpub = remember(linkKey) {
        linkKey?.let { k -> runCatching { Nip19.npub(Secp.pubkeyHex(Nip19.decodeNsec(k))) }.getOrNull() }
    }
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

        // 0. A login link (the PWA's backup link, `#/login?nsec=`), only on explicit confirmation.
        val k = linkKey
        if (k != null && linkNpub != null) {
            Card {
                SectionTitle(s.t("signin.link.title"))
                Dim(s.t("signin.link.body"))
                Text(linkNpub, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                PrimaryButton(s.t("signin.link.use"), {
                    busy = "link"; error = null
                    scope.launch {
                        val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                            runCatching { c.session.importKey(k) }
                        }
                        busy = null
                        r.onSuccess { linkKey = null; finish() }.onFailure { error = s.t("signin.paste.invalid") }
                    }
                }, busy = busy == "link", icon = Icons.Outlined.Key)
                LinkButton(s.t("signin.link.ignore"), { linkKey = null })
            }
        }

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
                    // The nostrconnect URI carries the pairing secret (R-73).
                    today.cypherpunk.nostrautica.ui.components.SecureWindow()
                    Dim(s.t("signin.remote.scan"))
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { QrCode(o.uri) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        LinkButton(s.t("signin.remote.copy"), { today.cypherpunk.nostrautica.ui.components.Secrets.copy(ctx, o.uri) })
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
                // The public profile photo (Login.svelte), the Join flow's picker.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(64.dp).clip(CircleShape).border(1.dp, t.border, CircleShape)
                            .clickable { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                        contentAlignment = Alignment.Center,
                    ) {
                        val ph = newPhoto
                        if (ph != null) AsyncImage(ph, null, Modifier.size(64.dp).clip(CircleShape), contentScale = ContentScale.Crop)
                        else Icon(Icons.Outlined.Add, s.t("login.photoAdd"), tint = t.textDim)
                    }
                    Spacer(Modifier.width(12.dp))
                    androidx.compose.foundation.layout.Column {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Dim(s.t("login.photoAdd"), size = 13)
                            Pill(s.t("login.photoPublic"), t.bgElev2, t.textDim)
                        }
                        Dim(s.t("login.photoTap"), size = 13)
                        if (newPhoto != null) LinkButton(s.t("join.android.photoRemove"), { newPhoto = null })
                    }
                }
                Field(name, { name = it }, s.t("login.yourName"), placeholder = s.t("login.namePlaceholder"))
                PrimaryButton(if (busy == "create") s.t("login.creating") else s.t("login.createMyIdentity"), {
                    busy = "create"; error = null
                    scope.launch {
                        // Prepare the photo BEFORE creating the key: a bad image fails closed, with no
                        // side effects and nothing uploaded raw (APPR-3).
                        val avatar = try {
                            newPhoto?.let { PublicImages.prepareAvatar(ctx, it) }
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = errorText(e, s); busy = null; return@launch
                        }
                        val acct = c.session.createLocalKey()
                        // An upload failure still proceeds photo-less, as on the web, but says so.
                        val picture = avatar?.let { bytes ->
                            runCatching { PublicImages.upload(c.introMedia, acct.signer, bytes, "image/jpeg") }
                                .onFailure { Toasts.show(s.t("join.android.photoNotUploaded")) }.getOrNull()
                        }
                        runCatching { c.social.onboard(name.trim(), picture) }
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
