package today.cypherpunk.nostrautica.ui.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import today.cypherpunk.nostrautica.domain.Role

/** stores/visitor-preview.svelte.ts: one coordinate, organizers only. */
class VisitorPreviewTest {
    private val a = "31923:aa:one"
    private val b = "31923:aa:two"

    @After fun reset() { if (VisitorPreview.isActive(VisitorPreview.coordinate.value)) VisitorPreview.toggle(VisitorPreview.coordinate.value!!) }

    @Test fun togglesForOneCoordinate() {
        assertFalse(VisitorPreview.isActive(a))
        VisitorPreview.toggle(a)
        assertTrue(VisitorPreview.isActive(a))
        assertFalse(VisitorPreview.isActive(b))
        assertFalse(VisitorPreview.isActive(null))
        VisitorPreview.toggle(b) // switching events moves the preview, never stacks it
        assertFalse(VisitorPreview.isActive(a))
        VisitorPreview.toggle(b)
        assertEquals(null, VisitorPreview.coordinate.value)
    }

    @Test fun onlyTheOrganizerOfThatEventIsDemoted() {
        assertEquals(Role.VISITOR, VisitorPreview.effectiveRole(Role.ORGANIZER, a, a))
        assertEquals(Role.ORGANIZER, VisitorPreview.effectiveRole(Role.ORGANIZER, b, a))
        assertEquals(Role.ORGANIZER, VisitorPreview.effectiveRole(Role.ORGANIZER, a, null))
        assertEquals(Role.ATTENDEE, VisitorPreview.effectiveRole(Role.ATTENDEE, a, a))
        assertEquals(Role.PENDING, VisitorPreview.effectiveRole(Role.PENDING, a, a))
    }
}
