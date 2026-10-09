package today.cypherpunk.nostrautica.domain.organizer

import kotlinx.serialization.Serializable
import today.cypherpunk.nostrautica.protocol.InviteEntry
import today.cypherpunk.nostrautica.protocol.Nip19
import today.cypherpunk.nostrautica.protocol.ProtocolCrypto
import today.cypherpunk.nostrautica.protocol.Secp
import today.cypherpunk.nostrautica.protocol.isHex32
import today.cypherpunk.nostrautica.protocol.isHex64
import java.time.Instant

/** A code this session minted (organizer.ts GeneratedInvite). Never persisted (§13.3). */
data class GeneratedInvite(
    val label: String,
    val nsec: String,
    val link: String,
    /** Distinct redemptions; 0 = unlimited. */
    val uses: Int = 1,
    val exp: Long? = null,
) {
    val pubkey: String? get() = runCatching { Secp.pubkeyHex(Nip19.decodeNsec(nsec)) }.getOrNull()
}

/**
 * Invite codes (§6.5) and the two exports (invite-export.ts, invite-sheet.ts). Pure:
 * minting a batch returns both the codes and the merged list to republish, so the
 * whole-document rewrite can be tested without a relay.
 */
object Invites {
    data class Batch(val generated: List<GeneratedInvite>, val list: List<InviteEntry>)

    /**
     * organizer.ts generateInvites: labels are numbered off the merged list so they
     * stay unique and monotonic across batches; `uses`/`exp` are emitted only when
     * they differ from the single-use default, so an ordinary batch publishes
     * byte-identical entries to earlier builds.
     */
    fun mint(
        existing: List<InviteEntry>,
        count: Int,
        joinLinkBase: String,
        lang: String?,
        labelPrefix: String = "invite",
        uses: Int? = null,
        exp: Long? = null,
        newSecret: () -> ByteArray = Secp::generateSecret,
    ): Batch {
        val list = existing.toMutableList()
        val out = mutableListOf<GeneratedInvite>()
        val langQuery = if (!lang.isNullOrEmpty() && lang != "en") "&lang=" + java.net.URLEncoder.encode(lang, "UTF-8") else ""
        val policyUses = uses?.takeIf { it != 1 }
        repeat(count) {
            val sk = newSecret()
            val label = "$labelPrefix-${list.size + 1}"
            list += InviteEntry(h = ProtocolCrypto.inviteHash(Secp.pubkeyHex(sk)), label = label, uses = policyUses, exp = exp)
            val nsec = Nip19.nsec(sk)
            out += GeneratedInvite(label, nsec, "$joinLinkBase?code=$nsec$langQuery", uses ?: 1, exp)
        }
        return Batch(out, list)
    }

    /**
     * The `exp` of a shared entry code from "valid for (hours)". 0, blank or negative
     * means NO expiry (the field is omitted) — never "one hour", which is the
     * 2026-09-15 incident this guards against.
     */
    fun sharedInviteExp(hours: Double?, nowMs: Long): Long? {
        if (hours == null || !hours.isFinite() || hours <= 0) return null
        return nowMs / 1000 + Math.round(hours * 3600)
    }

    fun isInviteValid(proof: InviteProofRef, published: Set<String>, coordinate: String, attendee: String): Boolean {
        if (!proof.invitePubkey.isHex32() || !proof.sig.isHex64()) return false
        return ProtocolCrypto.inviteHash(proof.invitePubkey) in published &&
            ProtocolCrypto.verifyInviteProof(ProtocolCrypto.InviteProof(proof.invitePubkey, proof.sig), coordinate, attendee)
    }

    // ── CSV (RFC 4180, formula-injection safe) ──────────────────────────────

    const val CSV_BOM = "﻿"
    private val FORMULA_LEAD = Regex("^[=+\\-@\t\r]")

    fun csvCell(value: Any?): String {
        var s = value?.toString() ?: ""
        if (FORMULA_LEAD.containsMatchIn(s)) s = "'$s"
        if (s.any { it == '"' || it == '\n' || it == '\r' || it == ',' }) s = "\"" + s.replace("\"", "\"\"") + "\""
        return s
    }

    fun csvDocument(rows: List<List<Any?>>): String = rows.joinToString("\r\n") { r -> r.joinToString(",") { csvCell(it) } } + "\r\n"

    fun codesCsv(invites: List<GeneratedInvite>): String =
        csvDocument(listOf(listOf("label", "code", "link")) + invites.map { listOf(it.label, it.nsec, it.link) })

    fun codesTxt(invites: List<GeneratedInvite>): String = invites.joinToString("\n") { it.link }

    // ── "Who has joined" report ──────────────────────────────────────────────

    @Serializable
    data class Issued(val h: String, val label: String? = null)

    @Serializable
    data class Used(val at: Long, val pubkey: String, val name: String? = null)

    @Serializable
    data class Report(val v: Int = 1, val issued: List<Issued> = emptyList(), val used: Map<String, Used> = emptyMap())

    /** Earliest valid redemption per code hash, from requests this device unwrapped. */
    fun observeUsed(requests: List<PendingRequest>, published: Set<String>, coordinate: String): Map<String, Used> {
        val out = HashMap<String, Used>()
        for (r in requests) {
            val inv = r.invite ?: continue
            if (!isInviteValid(inv, published, coordinate, r.attendeePubkey)) continue
            val h = ProtocolCrypto.inviteHash(inv.invitePubkey)
            val prev = out[h]
            val earlier = prev == null || r.rumorCreatedAt < prev.at || (r.rumorCreatedAt == prev.at && r.attendeePubkey < prev.pubkey)
            if (earlier) out[h] = Used(r.rumorCreatedAt, r.attendeePubkey, r.name.ifBlank { null })
        }
        return out
    }

    /** Union-only: once a code is seen used it stays used. */
    fun mergeUsage(prev: Map<String, Used>?, next: Map<String, Used>): Map<String, Used> {
        val out = LinkedHashMap(prev ?: emptyMap())
        for ((h, rec) in next) {
            val old = out[h]
            out[h] = if (old == null) rec else {
                val w = if (rec.at < old.at) rec else old
                w.copy(name = w.name ?: old.name ?: rec.name)
            }
        }
        return out
    }

    fun mergeIssued(prev: List<Issued>?, next: List<Issued>): List<Issued> {
        val seen = HashSet<String>()
        return (next + (prev ?: emptyList())).filter { seen.add(it.h) }
    }

    data class UsageRow(val label: String, val used: Boolean, val usedAt: Long? = null, val npub: String? = null, val displayName: String? = null)

    fun buildUsageRows(issued: List<Issued>, used: Map<String, Used>, nameOf: (String) -> String? = { null }): List<UsageRow> = issued.map { inv ->
        val label = inv.label ?: inv.h.take(12)
        val rec = used[inv.h] ?: return@map UsageRow(label, false)
        val name = nameOf(rec.pubkey)?.trim()?.ifEmpty { null } ?: rec.name?.trim()?.ifEmpty { null }
        UsageRow(label, true, rec.at, runCatching { Nip19.npub(rec.pubkey) }.getOrDefault(rec.pubkey), name)
    }

    fun filterUsageRows(rows: List<UsageRow>, unusedOnly: Boolean) = if (unusedOnly) rows.filter { !it.used } else rows

    fun usedCount(rows: List<UsageRow>) = rows.count { it.used }

    fun usageCsv(rows: List<UsageRow>): String = csvDocument(
        listOf(listOf("label", "used", "used_at", "npub", "display_name")) + rows.map { r ->
            listOf(r.label, if (r.used) "yes" else "no", r.usedAt?.let { isoSeconds(it) } ?: "", r.npub ?: "", r.displayName ?: "")
        },
    )

    /** `new Date(s*1000).toISOString()`: always millisecond precision, Z. */
    fun isoSeconds(sec: Long): String {
        val s = Instant.ofEpochSecond(sec).toString() // 2026-10-09T12:00:00Z
        return s.removeSuffix("Z") + ".000Z"
    }

    fun exportFilename(kind: String, naddr: String, ext: String): String {
        val slug = naddr.filter { it.isLetterOrDigit() && it.code < 128 }.take(12).ifEmpty { "event" }
        return "nostrautica-$kind-$slug.$ext"
    }

    /** invite-sheet.ts: drop single-use codes already redeemed; multi-use codes stay. */
    fun forSheet(generated: List<GeneratedInvite>, used: Map<String, Used>): List<GeneratedInvite> = generated.filter { inv ->
        if (inv.uses != 1) return@filter true
        val pk = inv.pubkey ?: return@filter true
        used[ProtocolCrypto.inviteHash(pk)] == null
    }
}
