package today.cypherpunk.nostrautica.signer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder

/** The email-yourself backup matches signer/backup.ts loginLink / mailtoBackup. */
class BackupTest {
    private val nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"

    @Test fun loginLinkTrimsTheBaseLikeTheWeb() {
        val want = "https://nostrautica.cypherpunk.today/app/#/login?nsec=$nsec"
        assertEquals(want, Backup.loginLink("https://nostrautica.cypherpunk.today/app/", nsec))
        assertEquals(want, Backup.loginLink("https://nostrautica.cypherpunk.today/app#/", nsec))
    }

    @Test fun mailtoCarriesTheWebSubjectAndBody() {
        val m = Backup.mailto("https://nostrautica.cypherpunk.today/app/", nsec)
        // mailtoBackup()'s output for the same input, produced by running backup.ts's code in node.
        val web = "mailto:?subject=Your%20Nostrautica%20key&body=This%20link%20logs%20you%20back%20into%20Nostrautica%20on%20any%20device." +
            "%0AKeep%20this%20email%20private%3A%20anyone%20with%20this%20link%20controls%20your%20account.%0A%0A" +
            "https%3A%2F%2Fnostrautica.cypherpunk.today%2Fapp%2F%23%2Flogin%3Fnsec%3D$nsec%0A%0A" +
            "(Email%20is%20not%20confidential%20transport.%20This%20is%20a%20convenience%20trade-off%0A" +
            "against%20losing%20access%20to%20your%20identity.)"
        assertEquals(web, m)
        val body = URLDecoder.decode(m.substringAfter("&body=").replace("+", "%2B"), "UTF-8")
        assertEquals(Backup.emailBody("https://nostrautica.cypherpunk.today/app/", nsec), body)
        assertEquals(7, body.lines().size)
    }

    @Test fun encodesLikeEncodeUriComponent() {
        assertEquals("a%20b!~*'()%2B%26%3D%C3%A1", Backup.encodeUriComponent("a b!~*'()+&=á"))
    }
}
