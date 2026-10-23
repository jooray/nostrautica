package today.cypherpunk.nostrautica.signer

import java.net.URLEncoder

/**
 * signer/backup.ts: the email-yourself recovery link. The nsec rides in the URL
 * fragment of the web app's login route (never sent to a server), which this app
 * also opens, behind its explicit confirmation (SB-22).
 */
object Backup {
    /** What the web's file download names the NIP-49 export. */
    const val NCRYPTSEC_FILE = "nostrautica-key.ncryptsec"

    const val EMAIL_SUBJECT = "Your Nostrautica key"

    /** loginLink(): `<app>/#/login?nsec=…`. */
    fun loginLink(appBaseUrl: String, nsec: String): String = appBaseUrl.trimEnd('#', '/') + "/#/login?nsec=" + nsec

    /** The email body, word for word the web's (it is not translated there either). */
    fun emailBody(appBaseUrl: String, nsec: String): String = listOf(
        "This link logs you back into Nostrautica on any device.",
        "Keep this email private: anyone with this link controls your account.",
        "",
        loginLink(appBaseUrl, nsec),
        "",
        "(Email is not confidential transport. This is a convenience trade-off",
        "against losing access to your identity.)",
    ).joinToString("\n")

    /** mailtoBackup(): `mailto:?subject=…&body=…`, encoded as encodeURIComponent does. */
    fun mailto(appBaseUrl: String, nsec: String): String =
        "mailto:?subject=${encodeUriComponent(EMAIL_SUBJECT)}&body=${encodeUriComponent(emailBody(appBaseUrl, nsec))}"

    /** JavaScript's encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is escaped. */
    fun encodeUriComponent(s: String): String = URLEncoder.encode(s, "UTF-8")
        .replace("+", "%20").replace("%21", "!").replace("%27", "'")
        .replace("%28", "(").replace("%29", ")").replace("%7E", "~")
}
