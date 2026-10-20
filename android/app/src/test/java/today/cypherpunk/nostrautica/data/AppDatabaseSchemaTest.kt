package today.cypherpunk.nostrautica.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import today.cypherpunk.nostrautica.data.db.AppDatabase
import today.cypherpunk.nostrautica.data.db.OutboxRow
import java.io.File

/**
 * Audit DS41-065 / SB-21: the database holds the durable outbox, so every schema
 * version must have its exported schema and a migration from the one before it.
 * Bumping [AppDatabase.VERSION] without both fails here instead of on a phone.
 */
@RunWith(RobolectricTestRunner::class)
class AppDatabaseSchemaTest {
    private val dir = listOf("schemas", "app/schemas").map(::File).first { it.exists() }
        .resolve("today.cypherpunk.nostrautica.data.db.AppDatabase")

    @Test fun everyVersionHasItsSchemaAndAMigrationFromThePreviousOne() {
        for (v in 1..AppDatabase.VERSION) {
            val f = dir.resolve("$v.json")
            assertTrue("missing exported schema $f", f.exists())
            val version = Json.parseToJsonElement(f.readText()).jsonObject["database"]!!.jsonObject["version"]!!.jsonPrimitive.int
            assertEquals(v, version)
        }
        val steps = AppDatabase.MIGRATIONS.map { it.startVersion to it.endVersion }
        assertEquals((1 until AppDatabase.VERSION).map { it to it + 1 }, steps)
    }

    @Test fun reopeningKeepsTheOutbox() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val row = OutboxRow("id1", "owner", "{}", "[]", "[]", 0, 0, 0, false, false, "join")
        AppDatabase.open(ctx).also { it.outbox().put(row) }.close()
        val db = AppDatabase.open(ctx)
        assertEquals(listOf(row), db.outbox().all())
        db.close()
    }
}
