package today.cypherpunk.nostrautica.nostr

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.protocol.JsJson
import today.cypherpunk.nostrautica.protocol.Kinds
import today.cypherpunk.nostrautica.protocol.LocalSigner

@RunWith(RobolectricTestRunner::class)
class RelayPoolTest {
    private val relays = mutableListOf<FakeRelay>()
    private fun relay() = FakeRelay().also { relays += it }
    private val pool = RelayPool(RelayPool.newHttpClient())
    private val filter = listOf(Filter(kinds = listOf(Kinds.APP_DATA), limit = 1))

    @After fun down() = relays.forEach { it.close() }

    // Audit DS41-055: a CLOSED used to count as an answer, so "rate-limited" read as "no seed exists".
    @Test fun closedIsNotAnAnswer() = runBlocking {
        val r = relay().apply { onReq = { ws, sub, _ -> ws.send("""["CLOSED",${JsJson.quote(sub)},"rate-limited: slow down"]""") } }
        val got = pool.fetch(listOf(r.url), filter, timeoutMs = 5_000)
        assertEquals(0, got.answered)
        assertFalse(got.complete)
    }

    @Test fun eoseIsAnAnswer() = runBlocking {
        val r = relay()
        val got = pool.fetch(listOf(r.url), filter, timeoutMs = 5_000)
        assertEquals(1, got.answered)
        assertTrue(got.complete)
    }

    // Audit DS41-058: the OK waits run side by side, so two dead relays cost one timeout, not two.
    @Test fun publishWaitsForAllRelaysUnderOneDeadline() = runBlocking {
        val ok = relay()
        val deadA = relay().apply { onEvent = { _, _ -> } }
        val deadB = relay().apply { onEvent = { _, _ -> } }
        val ev = LocalSigner.generate().let { it.signNow(it.template(Kinds.APP_DATA, "x", emptyList())) }
        val started = System.currentTimeMillis()
        val out = pool.publish(ev, listOf(deadA.url, deadB.url, ok.url), timeoutMs = 2_000)
        val took = System.currentTimeMillis() - started
        assertTrue("took $took ms", took < 3_500) // sequential: ≥ 4 s
        assertEquals(RelayPool.PublishOutcome.Ok, out[RelayPool.normalize(ok.url)])
        assertEquals(RelayPool.PublishOutcome.Timeout, out[RelayPool.normalize(deadA.url)])
    }

    // Audit DS41-062: one relay's EOSE is not the end of a history another relay didn't answer.
    @Test fun aPartialAnswerIsNotComplete() = runBlocking {
        val ok = relay()
        val silent = relay().apply { onReq = { _, _, _ -> } }
        val closing = relay().apply { onReq = { ws, sub, _ -> ws.send("""["CLOSED",${JsJson.quote(sub)},"auth-required: x"]""") } }
        val got = pool.fetch(listOf(ok.url, silent.url, closing.url), filter, timeoutMs = 5_000)
        assertEquals(1, got.answered)
        assertEquals(3, got.targets)
        assertFalse(got.complete)
    }
}
