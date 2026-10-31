package today.cypherpunk.nostrautica.domain.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Audit S-2: the device kind-0 goes out only when it changed (or a week passed). */
class DeviceProfileStampTest {
    private val relays = listOf("wss://a.example", "wss://b.example")

    @Test fun unchangedContentAndRelaysAreNotRepublished() {
        val h = DeviceProfileStamp.hash("{\"name\":\"Ann\"}", relays)
        val stamp = DeviceProfileStamp.stamp(h, 1_000)
        assertFalse(DeviceProfileStamp.due(stamp, h, 1_000 + 3600))
        // Relay order doesn't matter.
        assertEquals(h, DeviceProfileStamp.hash("{\"name\":\"Ann\"}", relays.reversed()))
    }

    @Test fun aChangeOrAWeekRepublishes() {
        val h = DeviceProfileStamp.hash("{\"name\":\"Ann\"}", relays)
        val stamp = DeviceProfileStamp.stamp(h, 1_000)
        assertTrue(DeviceProfileStamp.due(stamp, DeviceProfileStamp.hash("{\"name\":\"Bea\"}", relays), 1_001))
        assertTrue(DeviceProfileStamp.due(stamp, DeviceProfileStamp.hash("{\"name\":\"Ann\"}", relays + "wss://c.example"), 1_001))
        assertTrue(DeviceProfileStamp.due(stamp, h, 1_000 + DeviceProfileStamp.REPUBLISH_SEC))
    }

    @Test fun noOrBrokenStampPublishes() {
        val h = DeviceProfileStamp.hash("x", relays)
        assertTrue(DeviceProfileStamp.due(null, h, 1))
        assertTrue(DeviceProfileStamp.due("garbage", h, 1))
        // A stamp from the future (clock moved back) doesn't block forever.
        assertTrue(DeviceProfileStamp.due(DeviceProfileStamp.stamp(h, 10_000), h, 1))
    }
}
