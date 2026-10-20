package today.cypherpunk.nostrautica.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The TypeScript package's verdicts on payloads and tags at the edges of the
 * protocol's bounds (tools/vectors/parity.mjs → parity-vectors.json), replayed
 * against the Kotlin port. Audit SB-72..SB-85: wherever the two disagreed, the PWA
 * and the coordinator dropped what the Android app showed, or the reverse.
 */
class ParityVectorsTest {
    private val v = Json.parseToJsonElement(javaClass.classLoader!!.getResource("parity-vectors.json")!!.readText()).jsonObject

    @Suppress("UNCHECKED_CAST")
    private val serializers: Map<String, KSerializer<out Validated>> = mapOf(
        "eventPageContent" to EventPageContent.serializer(),
        "eventPagePrivate" to EventPagePrivate.serializer(),
        "rosterContent" to RosterContent.serializer(),
        "directoryEntryContent" to DirectoryEntryContent.serializer(),
        "profileCorrectionContent" to ProfileCorrectionContent.serializer(),
        "keyGrantContent" to KeyGrantContent.serializer(),
        "coordinatorAnnounce" to CoordinatorAnnounce.serializer(),
        "myProfileContent" to MyProfileContent.serializer(),
        "eventKeysBackup" to EventKeysBackup.serializer(),
        "talkSubmissionContent" to TalkSubmissionContent.serializer(),
        "perEventSettings" to PerEventSettings.serializer(),
        "organizerGrantContent" to OrganizerGrantContent.serializer(),
    )

    private fun tags(e: kotlinx.serialization.json.JsonElement) = e.jsonArray.map { t -> t.jsonArray.map { it.jsonPrimitive.content } }

    @Test fun payloadsAreAcceptedAndRejectedLikeTs() {
        val wrong = mutableListOf<String>()
        for (p in v["payloads"]!!.jsonArray.map { it.jsonObject }) {
            val schema = p["schema"]!!.jsonPrimitive.content
            val ser = serializers[schema] ?: error("no Kotlin serializer mapped for $schema")
            val want = p["ok"]!!.jsonPrimitive.boolean
            val got = Wire.parseSafe(ser, p["payload"]!!) is Wire.Result.Ok
            if (got != want) wrong += "$schema / ${p["label"]!!.jsonPrimitive.content}: TS ${if (want) "accepts" else "rejects"}, Kotlin ${if (got) "accepts" else "rejects"}"
        }
        assertTrue(wrong.joinToString("\n"), wrong.isEmpty())
    }

    @Test fun configTagsParseLikeTs() {
        val pk = "e0".repeat(32)
        for (c in v["configs"]!!.jsonArray.map { it.jsonObject }) {
            val label = c["label"]!!.jsonPrimitive.content
            val got = runCatching { EventConfig.parse(pk, tags(c["tags"]!!)) }.getOrNull()
            val want = c["parsed"]!!
            if (want is JsonNull) { assertEquals("$label: TS rejects", null, got); continue }
            val w = want.jsonObject
            assertTrue("$label: TS accepts", got != null)
            assertEquals(label, (w["coordinator"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it !is JsonNull }?.content, got!!.coordinator)
            assertEquals(label, (w["coordinatorGen"]!! as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it !is JsonNull }?.int, got.coordinatorGen)
            assertEquals(label, w["relays"]!!.jsonArray.map { it.jsonPrimitive.content }, got.relays)
            assertEquals(label, w["chatRelays"]!!.jsonArray.map { it.jsonPrimitive.content }, got.chatRelays)
        }
    }

    @Test fun coordinatesParseLikeTs() {
        for (c in v["coordinates"]!!.jsonArray.map { it.jsonObject }) {
            val s = c["s"]!!.jsonPrimitive.content
            assertEquals(s, c["ok"]!!.jsonPrimitive.boolean, Coordinate.parseOrNull(s) != null)
        }
    }

    @Test fun publicMenuIsBoundedLikeTs() {
        val m = v["menu"]!!.jsonObject
        val want = m["items"]!!.jsonArray.map { it.jsonObject.let { o -> o["label"]!!.jsonPrimitive.content to o["target"]!!.jsonPrimitive.content } }
        assertEquals(want, EventPage.rTagsToMenu(tags(m["tags"]!!)).map { it.label to it.target })
    }

    private fun settings(e: kotlinx.serialization.json.JsonElement) = Wire.json.decodeFromJsonElement(PerEventSettings.serializer(), e)
    private fun json(s: PerEventSettings) = Wire.json.encodeToJsonElement(PerEventSettings.serializer(), s)

    @Test fun settingsMergeLikeTs() {
        // SB-88: both ports must converge on the same document, byte for byte in
        // meaning, or a phone and a laptop would keep rewriting each other.
        for (m in v["settingsMerges"]!!.jsonArray.map { it.jsonObject }) {
            val got = SettingsMerge.merge(settings(m["a"]!!), m["aAt"]!!.jsonPrimitive.content.toLong(), settings(m["b"]!!), m["bAt"]!!.jsonPrimitive.content.toLong())
            assertEquals(m["label"]!!.jsonPrimitive.content, m["out"]!!, json(got))
        }
        for (m in v["settingsEdits"]!!.jsonArray.map { it.jsonObject }) {
            val e = m["edit"]!!.jsonObject
            val edit = if (e["kind"]!!.jsonPrimitive.content == "toggle") {
                val f = when (e["list"]!!.jsonPrimitive.content) {
                    "favorites" -> SettingsMerge.Field.FAVORITES
                    "want_to_meet" -> SettingsMerge.Field.WANT_TO_MEET
                    else -> SettingsMerge.Field.MET
                }
                SettingsMerge.Edit.Toggle(f, e["pubkey"]!!.jsonPrimitive.content)
            } else SettingsMerge.Edit.Note(e["pubkey"]!!.jsonPrimitive.content, e["note"]!!.jsonPrimitive.content)
            val got = SettingsMerge.edit(settings(m["doc"]!!), m["docAt"]!!.jsonPrimitive.content.toLong(), edit, m["nowMs"]!!.jsonPrimitive.content.toLong())
            assertEquals(m["label"]!!.jsonPrimitive.content, m["out"]!!, json(got))
        }
    }

    @Test fun eckIdentityLikeTs() {
        val e = v["eckIdentity"]!!.jsonObject
        val versions = { el: kotlinx.serialization.json.JsonElement -> Wire.json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(EckVersion.serializer()), el) }
        for (f in e["fingerprints"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(f["fp"]!!.jsonPrimitive.content, EckIdentity.fingerprint(f["key"]!!.jsonPrimitive.content))
        }
        for (s in e["sets"]!!.jsonArray.map { it.jsonObject }) {
            val set = versions(s["set"]!!)
            assertEquals(versions(s["union"]!!), EckIdentity.union(set))
            assertEquals(Wire.json.decodeFromJsonElement(EckVersion.serializer(), s["canonical"]!!), EckIdentity.canonical(set))
            assertEquals(s["collisions"]!!.jsonArray.map { it.jsonPrimitive.int }, EckIdentity.collisionIds(set))
        }
        for (t in e["tags"]!!.jsonArray.map { it.jsonObject }) {
            val got = EckIdentity.readTag(listOf(t["tag"]!!.jsonArray.map { it.jsonPrimitive.content }))
            val want = t["ref"]!!
            if (want is JsonNull) assertEquals(null, got)
            else assertEquals(EckIdentity.Ref(want.jsonObject["id"]!!.jsonPrimitive.int, want.jsonObject["fp"]?.jsonPrimitive?.content), got)
        }
    }

    @Test fun eventKeysBackupMergeLikeTs() {
        val ser = EventKeysBackup.serializer()
        for (m in v["backupMerges"]!!.jsonArray.map { it.jsonObject }) {
            val cfg = m["configInbox"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            val got = KeysBackup.merge(Wire.json.decodeFromJsonElement(ser, m["a"]!!), Wire.json.decodeFromJsonElement(ser, m["b"]!!), cfg)
            assertEquals(m["label"]!!.jsonPrimitive.content, Wire.json.decodeFromJsonElement(ser, m["out"]!!), got)
        }
    }

    @Test fun aLibraryEntryKeepsItsExplicitNullA() {
        // SB-85: the key must be present for TS readers; @Required makes this reader agree.
        val ok = Wire.parseSafe(MyProfileContent.serializer(), JsonObject(mapOf("v" to kotlinx.serialization.json.JsonPrimitive(2), "a" to JsonNull)))
        assertTrue(ok is Wire.Result.Ok)
        // …and writing one keeps the key, although the format drops nulls elsewhere.
        val out = Wire.json.parseToJsonElement(Wire.encode(MyProfileContent.serializer(), MyProfileContent(a = null))).jsonObject
        assertEquals(JsonNull, out["a"])
    }
}
