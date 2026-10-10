package today.cypherpunk.nostrautica.protocol

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin port against the official NIP-44 suite and vectors produced by the TS implementation. */
class CryptoVectorsTest {
    private fun resource(name: String): JsonObject =
        Json.parseToJsonElement(javaClass.classLoader!!.getResource(name)!!.readText()).jsonObject

    private val nip44 = resource("nip44.vectors.json")["v2"]!!.jsonObject
    private val ts = resource("ts-vectors.json")
    private fun s(k: String) = ts[k]!!.jsonPrimitive.content

    @Test fun nip44ConversationKeys() {
        for (v in nip44["valid"]!!.jsonObject["get_conversation_key"]!!.jsonArray) {
            val o = v.jsonObject
            val key = Nip44.conversationKey(Bytes.fromHex(o["sec1"]!!.jsonPrimitive.content), o["pub2"]!!.jsonPrimitive.content)
            assertEquals(o["conversation_key"]!!.jsonPrimitive.content, Bytes.toHex(key))
        }
    }

    @Test fun nip44PaddedLengths() {
        for (v in nip44["valid"]!!.jsonObject["calc_padded_len"]!!.jsonArray) {
            val (len, padded) = v.jsonArray.map { it.jsonPrimitive.int }
            assertEquals(padded, Nip44.calcPaddedLen(len))
        }
    }

    @Test fun nip44EncryptDecrypt() {
        for (v in nip44["valid"]!!.jsonObject["encrypt_decrypt"]!!.jsonArray) {
            val o = v.jsonObject
            val sk1 = Bytes.fromHex(o["sec1"]!!.jsonPrimitive.content)
            val sk2 = Bytes.fromHex(o["sec2"]!!.jsonPrimitive.content)
            val key = Nip44.conversationKey(sk1, Secp.pubkey(sk2))
            assertEquals(o["conversation_key"]!!.jsonPrimitive.content, Bytes.toHex(key))
            val pt = o["plaintext"]!!.jsonPrimitive.content
            val payload = o["payload"]!!.jsonPrimitive.content
            assertEquals(payload, Nip44.encrypt(pt, key, Bytes.fromHex(o["nonce"]!!.jsonPrimitive.content)))
            assertEquals(pt, Nip44.decrypt(payload, key))
        }
    }

    @Test fun nip44RejectsInvalidPayloads() {
        for (v in nip44["invalid"]!!.jsonObject["decrypt"]!!.jsonArray) {
            val o = v.jsonObject
            val key = Bytes.fromHex(o["conversation_key"]!!.jsonPrimitive.content)
            assertThrows(Exception::class.java) { Nip44.decrypt(o["payload"]!!.jsonPrimitive.content, key) }
        }
        for (v in nip44["invalid"]!!.jsonObject["get_conversation_key"]!!.jsonArray) {
            val o = v.jsonObject
            assertThrows(Exception::class.java) {
                Nip44.conversationKey(Bytes.fromHex(o["sec1"]!!.jsonPrimitive.content), o["pub2"]!!.jsonPrimitive.content)
            }
        }
    }

    @Test fun eckUsesKeyDirectlyLikeTs() {
        val eck = Bytes.fromHex("11".repeat(32))
        assertEquals(s("eckCiphertext"), Nip44.encrypt("hello members", eck, Bytes.fromHex("22".repeat(32))))
        assertEquals("hello members", Nip44.eckDecrypt(eck, s("eckCiphertext")))
    }

    @Test fun keysAndSelfConversationKey() {
        val sk = Bytes.fromHex(s("sk"))
        assertEquals(s("pk"), Secp.pubkeyHex(sk))
        assertEquals(s("selfConversationKey"), Bytes.toHex(Nip44.selfConversationKey(sk)))
    }

    @Test fun blindedDMatchesTs() {
        val eck = Bytes.fromHex("11".repeat(32))
        assertEquals(s("blindedD"), ProtocolCrypto.blindedD(eck, s("coordinate"), s("pk")))
        assertEquals(s("blindedLibrary"), ProtocolCrypto.blindedDLiteral(eck, "library"))
    }

    @Test fun coordinatesAndNaddr() {
        val c = Coordinate.parse(s("coordinate"))
        assertEquals("plan-b:2026", c.identifier)
        assertEquals(s("naddr"), c.toNaddr(listOf("wss://nos.lol")))
        val (back, relays) = Coordinate.fromNaddr(s("naddr"))
        assertEquals(c, back)
        assertEquals(listOf("wss://nos.lol"), relays)
        assertEquals(s("communityNaddr"), Coordinate.make(s("pk"), "c1", Kinds.COMMUNITY).toNaddr())
        assertEquals(s("pk"), Nip19.decodeNpub(Nip19.npub(s("pk"))))
    }

    @Test fun eventIdSerializationMatchesJsonStringify() {
        val weird = s("weird")
        val id = NostrEvent.computeId(s("pk"), 1700000000, 1, listOf(listOf("t", weird), listOf("e", "x")), weird)
        assertEquals(s("eventId"), id)
    }

    @Test fun aesGcmMatchesWebCrypto() {
        val c = ProtocolCrypto.aesGcmEncrypt(Bytes.utf8("media bytes"), Bytes.fromHex("33".repeat(32)), Bytes.fromHex("44".repeat(12)))
        assertEquals(s("aesGcm"), Bytes.toHex(c.ciphertext))
        assertEquals("media bytes", String(ProtocolCrypto.aesGcmDecrypt(c.ciphertext, c.key, c.nonce)))
    }

    @Test fun inviteAndChatDeviceProofsVerifyAcrossImplementations() {
        assertEquals(s("inviteHash"), ProtocolCrypto.inviteHash(s("pk")))
        val p = ts["inviteProof"]!!.jsonObject
        val proof = ProtocolCrypto.InviteProof(p["invitePubkey"]!!.jsonPrimitive.content, p["sig"]!!.jsonPrimitive.content)
        assertTrue(ProtocolCrypto.verifyInviteProof(proof, s("coordinate"), s("pk")))
        assertFalse(ProtocolCrypto.verifyInviteProof(proof, s("coordinate"), "00".repeat(32)))
        assertTrue(ProtocolCrypto.verifyChatDeviceProof(s("chatDeviceProof"), s("coordinate"), s("pk"), s("chatDevicePubkey"), 1700000123))
        assertFalse(ProtocolCrypto.verifyChatDeviceProof(s("chatDeviceProof"), s("coordinate"), s("pk"), s("chatDevicePubkey"), 1700000124))
        // and ours verify with the same challenge
        val mine = ProtocolCrypto.makeChatDeviceProof(Bytes.fromHex("66".repeat(32)), s("coordinate"), s("pk"), 42)
        assertTrue(ProtocolCrypto.verifyChatDeviceProof(mine, s("coordinate"), s("pk"), s("chatDevicePubkey"), 42))
    }

    @Test fun unwrapsATsGiftWrap() {
        val wrap = NostrEvent.fromJson(ts["wrap"]!!)!!
        assertTrue(wrap.verify())
        val rumor = GiftWrap.unwrapLocal(wrap, Bytes.fromHex(s("wrapRecipientSk")))
        assertEquals(Kinds.JOIN_REQUEST, rumor.kind)
        assertEquals(s("pk"), rumor.pubkey)
        assertEquals("""{"v":2,"name":"Ada"}""", rumor.content)
        assertEquals(s("coordinate"), rumor.tag("a"))
        // A recipient that may not receive join requests rejects it at the unwrap.
        assertThrows(GiftWrap.UnwrapException::class.java) {
            GiftWrap.unwrapLocal(wrap, Bytes.fromHex(s("wrapRecipientSk")), Kinds.ATTENDEE_RUMOR_KINDS)
        }
    }

    @Test fun wrapRoundTripsThroughASigner() = runBlocking {
        val alice = LocalSigner.generate()
        val bob = LocalSigner.generate()
        val rumor = GiftWrap.rumor(alice.pubkey, Kinds.DM, "hi bob", listOf(listOf("p", bob.pubkey)))
        val wrap = GiftWrap.wrap(alice, bob.pubkey, rumor)
        assertTrue(wrap.verify())
        assertTrue(wrap.createdAt <= nowSec())
        val got = GiftWrap.unwrap(wrap, bob)
        assertEquals(rumor.id, got.id)
        assertEquals("hi bob", got.content)
    }

    @Test fun forgedSealIsRejected() {
        // A recipient can always produce a seal that DECRYPTS as "from Alice"; it cannot sign as her.
        val alice = LocalSigner.generate()
        val bobSk = Secp.generateSecret()
        val bob = Secp.pubkeyHex(bobSk)
        val rumor = GiftWrap.rumor(alice.pubkey, Kinds.KEY_GRANT, "{}")
        val forger = Secp.generateSecret()
        val fakeSeal = UnsignedEvent(alice.pubkey, nowSec(), Kinds.SEAL, emptyList(),
            Nip44.encrypt(JsJson.stringify(rumor.toRumorJson()), Nip44.conversationKey(bobSk, alice.pubkey)))
            .let { NostrEvent(it.id, it.pubkey, it.createdAt, it.kind, it.tags, it.content, Bytes.toHex(Secp.sign(Bytes.fromHex(it.id), forger))) }
        val wrap = GiftWrap.wrapSeal(fakeSeal, bob)
        assertThrows(GiftWrap.UnwrapException::class.java) { GiftWrap.unwrapLocal(wrap, bobSk) }
    }

    @Test fun futureRumorIsClampedForOrdering() {
        val a = LocalSigner.generate()
        val far = nowSec() + 3600
        val r = GiftWrap.rumor(a.pubkey, Kinds.DM, "x", createdAt = far)
        val got = GiftWrap.finalizeRumor(JsJson.stringify(r.toRumorJson()), a.pubkey, Kinds.RUMOR_KINDS)
        assertEquals(r.id, got.id)
        assertTrue(got.createdAt < far)
    }

    @Test fun nip44ShapeGuard() {
        assertFalse(Nip44.isCiphertext("abc?iv=def"))
        assertTrue(Nip44.isNip04Ciphertext("abc?iv=def"))
        assertTrue(Nip44.isCiphertext(s("eckCiphertext")))
    }

    @Test fun rumorTimestampIsLong() {
        val w = NostrEvent.fromJson(ts["wrap"]!!)!!
        assertEquals(ts["wrap"]!!.jsonObject["created_at"]!!.jsonPrimitive.long, w.createdAt)
    }
}
