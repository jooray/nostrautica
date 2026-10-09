package today.cypherpunk.nostrautica.domain.join

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.protocol.AttendeeProfile
import today.cypherpunk.nostrautica.protocol.Limits

/** events/authored-profile.ts behaviour. */
class AuthoredProfileTest {
    @Test fun repairsBareHostnamesButNotHandles() {
        assertEquals("https://example.com/", AuthoredProfile.normalizeLink("example.com"))
        assertEquals("https://github.com/me", AuthoredProfile.normalizeLink("github.com/me"))
        assertEquals("https://example.com/", AuthoredProfile.normalizeLink("HTTPS://Example.COM"))
        assertEquals("http://example.com/x?y=1", AuthoredProfile.normalizeLink("http://example.com/x?y=1"))
        assertNull(AuthoredProfile.normalizeLink("@my_handle"))
        assertNull(AuthoredProfile.normalizeLink("mailto:me@example.com"))
        assertNull(AuthoredProfile.normalizeLink("javascript:alert(1)"))
        assertNull(AuthoredProfile.normalizeLink("https://localhost/"))
        assertNull(AuthoredProfile.normalizeLink("   "))
    }

    @Test fun normalizeBoundsDedupesAndReportsDropped() {
        val p = AttendeeProfile(
            about = " " + "a".repeat(Limits.MAX_ABOUT + 10),
            skills = listOf(" rust ", "rust", "", "x".repeat(300)) + (1..60).map { "s$it" },
            lookingFor = "co-founder ",
            links = listOf("example.com", "https://example.com/", "@handle"),
        )
        val n = AuthoredProfile.normalize(p)
        assertEquals(Limits.MAX_ABOUT, n.profile.about.length)
        assertEquals("rust", n.profile.skills[0])
        assertEquals(Limits.MAX_SKILL, n.profile.skills[1].length)
        assertEquals(Limits.MAX_SKILLS, n.profile.skills.size)
        assertEquals("co-founder", n.profile.lookingFor)
        assertEquals(listOf("https://example.com/"), n.profile.links)
        assertEquals(listOf("@handle"), n.dropped)
        n.profile.validate()
    }

    @Test fun buildKeepsMediaAndParsesLists() {
        val f = AuthoredFields(about = " hi ", skills = "rust, rust,  go ,", lookingFor = "x", links = "a.com\nb.com, a.com", introText = "  ")
        val b = AuthoredProfile.build(f, emptyList())
        assertEquals(listOf("rust", "go"), b.profile.skills)
        assertEquals(listOf("a.com", "b.com"), b.profile.links)
        assertNull(b.introText)
        assertEquals("hi", b.profile.about)
    }

    @Test fun changedIgnoresWhitespace() {
        val a = AuthoredFields(about = "x")
        assertFalse(AuthoredProfile.changed(a, AuthoredFields(about = " x ")))
        assertTrue(AuthoredProfile.changed(a, AuthoredFields(about = "y")))
    }

    @Test fun fieldsFromProfile() {
        val f = AuthoredProfile.fieldsFrom(AttendeeProfile("a", listOf("x", "y"), "l", listOf("https://a.com/", "https://b.com/")), "intro")
        assertEquals("x, y", f.skills)
        assertEquals("https://a.com/\nhttps://b.com/", f.links)
        assertEquals("intro", f.introText)
    }
}
