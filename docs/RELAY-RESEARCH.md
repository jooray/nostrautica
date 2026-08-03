# Self-hosted Nostr relay + Blossom for Nostrautica

Research notes for running (or migrating to) a dedicated relay and Blossom
server for this app. Goal: support NIP-46 remote-signer auth traffic, Blossom
intro/media uploads, and encrypted + public event data — without becoming a
public spam dump — while still allowing a small set of trusted npubs full
write access (today’s `nostr.cypherpunk.today` whitelist model).

**Current production state (jl):**
~~`wss://nostr.cypherpunk.today` is `nostr-rs-relay` on `jl`
(`127.0.0.1:8324`, user `nostr-relay`, config
`/home/nostr-relay/nostr-rs-relay-config.toml`), nginx-proxied. Write path is
a hard `pubkey_whitelist` used primarily as the HomeRealm nvpn rendezvous
relay (six device keys).~~ **Superseded — see the probe below.** There is
**no** production Blossom on our infra today; the app defaults to public
servers (`blossom.band`, `nostr.download`), so §4's Phase 1 is still open.

**Probed 2026-07-31** (throwaway, non-whitelisted key, `nak event` per kind):
the relay now implements this document's own §7 recommendation — privileged
whitelist **OR** app-kind allowlist. A random key writes 0, 3, 5, 445, 1059,
10002, 10050, 24133, 30023, 30078, 30443, 31600–31611, 31923 successfully;
1, 6, 444, 10063, 21606 and 38421 are refused with exactly the pseudo-code's
`blocked: kind not allowed on this relay`. So the §3.2/§8 "what we run now"
rows below describe the *pre-migration* state and should be read as history.

The allowlist covers every kind this app publishes as an outer event. The
refusals are harmless today because 444 (Marmot Welcome) and 21606
(coordinator status) only ever travel as rumors inside a 1059 gift wrap, and
1/6/10063/38421 appear in this codebase only in read filters — but 10063 is
one feature away from being a real gap: if the app ever publishes a Blossom
server list, it will be refused here, and a 1-of-N-ack publish would hide it.
Re-run the probe after any allowlist change, and whenever a new kind is added
to `packages/protocol/src/registry.ts`.

This document does **not** change deploy hooks or code — research only.

---

## 1. What Nostrautica actually needs on the wire

| Use case | Kinds / protocol | Write authors | Must store? | Notes |
|---|---|---|---|---|
| NIP-46 remote signer (Amber / bunker) | **24133** (ephemeral range) | client + signer keys (often **one-time / per-connection**, not the user’s long-term npub) | **No** — fan-out only | App defaults: `relay.primal.net`, `nos.lol`, `relay.nsec.app`. Own relay is optional redundancy. |
| Gift wraps (joins, grants, DMs, admin) | **1059** outer wrap; seals **13**; rumors never published | **Random one-time wrap keys**; recipient in `p` tag | Yes (for delivery / offline) | Pure author-whitelist **rejects every gift wrap** unless the *wrap* pubkey is listed — useless. Need kind- or AUTH-aware policy. |
| Public event config / discovery | **31600**, **31611**, NIP-52 **31923/24/25**, kind **0/3/5**, **10002**, **10063**, … | Organizer, coordinator, attendees | Yes | Addressable / replaceable. |
| Encrypted business records | **31602–31610** (ECK / self-enc / match lists) | organizer, coordinator, attendees | Yes | Ciphertext only on relay. |
| Marmot chat | **30443** key packages; **443/444/445** group traffic | chat device keys | Yes | Often on chat-specific relays; can share home relay. |
| Blossom media | HTTP BUD-01/02/04/06; auth kind **24242** | any attendee uploading intro/avatar | Blob store | App uploads AES-GCM ciphertext as `application/octet-stream`. Primary server **must** accept that + CORS. |
| nvpn / personal “store anything” | arbitrary kinds | **fixed whitelist** of operator keys | Yes | Today’s `nostr.cypherpunk.today` job. Keep this class of access. |

Hard constraints from the product:

1. **Cannot** gate all writes on a static npub whitelist — attendees and gift-wrap
   authors are unknown / ephemeral.
2. **Can** keep a privileged whitelist that bypasses all other gates (operator,
   coordinator service key, nvpn devices).
3. Blossom must accept **octet-stream** ciphertext (public media CDNs that only
   allow images have already burned us in prod).
4. Prefer HTTPS Blossom URLs only (app schema is https-only).
5. Relay should not be a free-for-all kind-1 social dump.

---

## 2. Permissioning reality check

### 2.1 What actually works

| Gate | Strength | Breaks Nostrautica? | Notes |
|---|---|---|---|
| **Static pubkey whitelist (all kinds)** | Strong anti-spam | **Yes** — gift wraps + every new attendee | Fine only for nvpn / personal vault. |
| **Kind allowlist** (e.g. 0,3,5,13,1059,24133,31600–31611,30443,443–445,10002,10063,31923–25, …) | Medium | No, if list is complete | Best cheap filter against random notes. Miss a kind → silent app breakage. |
| **Whitelist OR kind-allowlist** | Strong for dump, open for app | No | **Recommended core policy.** Privileged keys: any kind. Everyone else: only app-relevant kinds (+ rate limits). |
| **NIP-42 AUTH required to write** | Medium | Partial — clients must support AUTH; gift-wrap authors are random so AUTH is on the *connection*, not event pubkey | Good companion to kind policy. strfry plugins see `authed`. |
| **Inbox-style: must `p`-tag a known pubkey** (Haven inbox) | Strong for “mail to me” | **Yes** for group/event traffic not tagging operator | Useful as a *sub-relay*, not the only event home. |
| **Web of Trust** | Medium spam filter | Risky for cold attendees with no follows | Haven chat/inbox; pyramid member-graph. Bad sole gate for open events. |
| **Invite / membership tree** (pyramid) | Strong community gate | Yes unless every attendee is invited into the relay | Great for a club; wrong default for open matchmaking events. |
| **PoW / pay-to-relay** | Spam cost | Friction for mobile Amber users | Optional secondary. |
| **Rate limits (IP + pubkey)** | Essential | No if generous for bursts | Always on. |
| **Referer / Origin = app origin** (HTTP only) | **Cosmetic** | No for browsers that send it; **yes** for curl/CLI/Amber-less uploaders if enforced strictly | Easy to spoof; browsers omit Referer on some cross-origin cases. OK as *soft* Blossom bot brake, never sole auth. |
| **CORS allowlist** (`Access-Control-Allow-Origin: https://nostrautica.cypherpunk.today`) | Browser-only | CLI uploaders unaffected | Stops random websites from using your Blossom from JS; does **not** stop `curl`. |
| **BUD-11 kind 24242 auth** | Real Blossom auth | No — app already does this | Required. Optionally require pubkey ∈ storage rule / whitelist / paid set. |

### 2.2 Gift wraps and NIP-46 specifically

- **Kind 1059** is signed by a **throwaway key**. Author whitelist on `event.pubkey`
  cannot work. Options that do work:
  - allow kind 1059 from anyone (rate-limited), optionally require NIP-42 on the
    websocket and/or a `p` tag pointing at a pubkey the relay cares about
    (inbox model);
  - or don’t host gift wraps on the locked relay at all (use public DM relays)
    and only host public + ECK addressables locally.
- **Kind 24133** is ephemeral (20000–29999). Relays must **accept and fan-out
  without durable store** (or short TTL). nostr-rs-relay and strfry both treat
  this range as ephemeral. A pure whitelist that drops unknown pubkeys also
  drops NIP-46 unless both ends’ keys are listed — which they aren’t for Amber
  per-connection signer keys.

### 2.3 “Referer gate” for Blossom

You asked about requiring uploads to “come from”
`https://nostrautica.cypherpunk.today/`.

| Mechanism | Effect |
|---|---|
| nginx `if ($http_referer !~* nostrautica\.cypherpunk\.today)` on `PUT /upload` | Blocks naive browser hotlinking and some bots; **trivial to spoof**; breaks non-browser uploaders; some browsers send bare origin or omit Referer. |
| CORS `Access-Control-Allow-Origin` only app origin | Real protection **for browser JS only**. Recommended. |
| BUD-11 + optional pubkey allow / paid quota | Real authorization. |

**Verdict:** do CORS allowlist + kind-24242 auth (+ optional size/MIME rules).
Add Referer check only as a mild nginx filter if you accept false positives;
do not call it security.

---

## 3. Software survey

### 3.1 Required reading: Haven, pyramid, strfry

#### Haven — https://github.com/barrydeen/haven

**What it is:** “Four relays in one” + built-in Blossom, on **khatru** + Badger/LMDB.
Personal sovereignty vault, not a general community app relay.

| Endpoint | Who writes | Who reads | Role |
|---|---|---|---|
| `/` outbox | owner + **whitelisted npubs only** | world | public notes; blastr to other relays |
| `/private` | owner + whitelist (AUTH) | same | drafts, ecash, sensitive |
| `/chat` | WoT (or whitelist bypass); chat/giftwrap kinds | AUTH + policy | DMs / groups |
| `/inbox` | notes that **`p`-tag** owner/whitelist; WoT | pull + store | notifications |
| Blossom (on outbox URL) | owner + whitelist only | world | media |

**Access control** (`docs/access-control.md`): whitelist = full owner powers
(outbox + Blossom + private + WoT bypass). Blacklist for chat/inbox.

**Important (user-noted):** Haven is **feature-complete**; barrydeen’s repo is
**bugfixes only** going forward
([announcement](https://jumble.social/notes/nevent1qvzqqqqqqypzpckv7l8jqspl8u4y54dn9rcduwlrs4v2040nxce0m2h0cunvrj8tqy88wumn8ghj7mn0wvhxcmmv9uq3wamnwvaz7tmjv4kxz7fwwpexjmtpdshxuet59uqzqnjwq82z3lq62mkalaxu2dlgnjxw2stcwxan9wl66s7eywwjljvqx0s8cp)).
Still maintained for fixes; don’t expect new policy models.

**Fit for Nostrautica:**

| Need | Haven fit |
|---|---|
| Whitelisted npubs store anything | **Excellent** (outbox + private + Blossom) |
| Arbitrary attendees publish 316xx / 1059 | **Poor** on outbox — not whitelisted ⇒ rejected |
| NIP-46 24133 | Not the design center; ephemeral policy is whatever khatru does per build — don’t rely on Haven as sole signer relay |
| Blossom intros for all attendees | **No** — upload is owner/whitelist only |
| Anti-flood | **Excellent** for a personal relay |

**Verdict:** great **personal / operator vault** (and fine Blossom for *your*
media). **Wrong** as the sole “event home relay” unless every attendee is
whitelisted (they can’t be). Could still run Haven for operator keys + a
*second* open-policy relay for the app.

#### pyramid — https://github.com/fiatjaf/pyramid

**What it is:** Actively developed (pushed 2026-07) **community** relay suite:
hierarchical **invite membership**, many subrelays on one process, **member-only
Blossom**, moderated/public/inbox/groups, NIP-05, negentropy, optional streaming.
One-line install (`easy.sh`). Built on the modern khatru line
(`fiatjaf.com/nostr/khatru`).

| Subrelay (typical) | Write policy |
|---|---|
| main `/` | **members only** |
| internal | members read/write |
| inbox | external → members, WoT/spam protections |
| moderated | public write, member approve |
| personal | per-member private notes |
| groups | group-admin gated |
| Blossom | **members only**, per-member quotas |

**Fit for Nostrautica:**

| Need | pyramid fit |
|---|---|
| Whitelist-equivalent (root + members store a lot) | **Good** — membership *is* the whitelist, and members invite down-tree |
| Open event: stranger attendee publishes join/giftwrap | **Only if** they’re members, or you use **moderated/inbox** paths carefully — default main relay rejects non-members |
| Grow membership with events | Possible (invite codes, join requests) but **product friction** every attendee must join the relay community |
| Blossom for attendees | Only after membership |
| Operator complexity | Low ops (UI config), higher **conceptual** fit work |

**Verdict:** best if you want a **Nostrautica club / closed community** with
invites. Awkward for “anyone with a link joins the event” without either
auto-inviting attendees (custom glue) or pointing event 31600 at a more open
subpolicy. Worth watching; not the path of least resistance for open events.

#### strfry — https://github.com/hoytech/strfry

**What it is:** High-performance C++ relay, LMDB, NIP-42, negentropy, zero-downtime
restart, **writePolicy plugins** (any language, JSONL stdin/stdout), router/sync.
No built-in Blossom. ~701★, very widely deployed. Ephemeral kinds supported
(`rejectEphemeralEventsOlderThanSeconds`, `ephemeralEventsLifetimeSeconds`).

**Policy model:** core stays dumb; **you** encode whitelist ∪ kind-allowlist ∪
rate logic in a plugin. Plugin receives `event`, `sourceInfo` (IP), optional
`authed` pubkey after NIP-42.

**Fit for Nostrautica:**

| Need | strfry fit |
|---|---|
| Custom “whitelist OR app kinds” | **Excellent** |
| NIP-46 ephemeral | **Yes** |
| Gift wraps | Allow kind 1059 in plugin |
| Privileged npubs full access | Trivial in plugin |
| Blossom | **Separate daemon** |
| Ops on jl (Alma, nginx already) | Compile or container; well-documented |

**Verdict:** **best relay core** for our policy shape if we’re willing to maintain
a small plugin and a separate Blossom. Natural migration off nostr-rs-relay when
whitelist-only becomes insufficient.

---

### 3.2 Current: nostr-rs-relay

https://git.sr.ht/~gheartsfield/nostr-rs-relay (mirror: scsibug/nostr-rs-relay)

- Rust, SQLite, low RAM, TOML config.
- **`pubkey_whitelist`**: if set, **only** those authors — no “OR kind” expression.
- **`event_kind_allowlist` / `event_kind_blacklist`**: global, not per-user.
- **gRPC `event_admission_server`**: external admit/deny (escape hatch for custom
  policy without migrating).
- NIP-42 optional; `nip42_dms` can restrict kind 4/44/1059 delivery to authed
  recipients.
- Pay-to-relay, NIP-05 verified users — optional.
- Ephemeral kinds: recognized and not durably stored like normal events.

**Can we stay?**

| Approach | Feasible? |
|---|---|
| Drop whitelist, use kind allowlist only | Yes — loses “privileged keys store anything” unless those kinds ⊆ allowlist |
| Whitelist only (status quo) | Yes for nvpn; **no** for Nostrautica attendees |
| Whitelist **and** open kinds for others | **Not in config** — need gRPC admission service or migrate |
| gRPC admission = custom policy | Yes — keep binary, write small admitter (whitelist ∪ kinds ∪ rate) |

**Verdict:** fine to **keep for nvpn** on `nostr.cypherpunk.today`. For
Nostrautica, either add a **gRPC admission helper** or run a **second relay**
(strfry/khatru) with app policy. Migrating the nvpn relay in place is optional
later; don’t break HomeRealm.

---

### 3.3 Other Nostr relays people run

| Software | Lang / DB | Stars (approx) | Blossom? | Policy hooks | Notes |
|---|---|---|---|---|---|
| **strfry** | C++ / LMDB | ~701 | No | Plugins | Performance default for serious relays |
| **nostr-rs-relay** | Rust / SQLite | ~709 | No | whitelist, kinds, gRPC | What we run now |
| **nostream** | TS / Postgres | ~816 | No | env + plugins | Heavier; familiar if Node-ops |
| **khatru** | Go framework | ~140 (old repo archived Jan 2026) | library | Full custom | Use `fiatjaf.com/nostr/khatru@master`; Haven/pyramid built on this family |
| **relayer** | Go framework | ~343 | No | custom | Older fiatjaf framework |
| **Haven** | Go | ~192 | **Yes** | owner/WoT/whitelist | Personal vault; feature-complete |
| **pyramid** | Go | ~69 | **Yes** (members) | invite hierarchy | Community OS |
| **nostrcheck-server** | Node / MariaDB | ~155 | **Yes** (+ NIP-96) | admin UI, invites, WoT plugins, payments | All-in-one “Nostr service provider”; heavy |
| **HORNETS** | — | ~39 | — | paid / public / invite modes + dashboard | Ops-friendly modes |
| **Citrine** | Kotlin | ~127 | No | phone relay | Mobile, not jl server |
| **NNostr** | C# | ~131 | No | — | .NET shops |
| **blobstr-relay** | — | small | Yes | selective file kinds | Specialized |

Public relays the **app already uses** (defaults in `packages/app/src/lib/nostr/relays.ts`):
`nos.lol`, `relay.primal.net`, `relay.nostr.net`, `nostr.mom`, `nostr.oxtr.dev`,
read `purplerelay.com`; NIP-46 also `relay.nsec.app`; Blossom defaults
`blossom.band`, `nostr.download` (route96).

---

### 3.4 Blossom servers

| Software | Stack | Auth / ACL | Notes |
|---|---|---|---|
| **hzrd149/blossom-server** | Deno, libSQL/SQLite, local or S3 | BUD-11; `requireAuth`; **`requirePubkeyInRule`** + per-pubkey retention rules; MIME rules; mirror; admin dashboard | **Same family as local e2e.** Accepts octet-stream. App explicitly trusts this implementation. |
| **v0l/route96** | Rust, MySQL | BUD-11, whitelist, quotas, LN payments, AI labeling | Powers **nostr.download** (our default mirror). Heavier deps (ffmpeg, MySQL). |
| **Haven built-in** | Go | whitelist/owner only | Too closed for attendees |
| **pyramid built-in** | Go | members only | Closed unless members |
| **nostrcheck-server** | Node | full user accounts, paid upload, AI mod | Kitchen sink |
| **Primal blossom** | — | often media-type picky | Already failed us for ciphertext |
| **cherry-server / blossom-rs / others** | various | varies | Smaller ecosystem |

**Nostrautica requirement:** BUD-02 upload + BUD-06 preflight + BUD-04 mirror
optional + CORS to app origin + **no** rejection of `application/octet-stream`.

---

## 4. Recommended architectures

### 4.1 Preference order (for this project)

1. **Recommended: strfry (app relay) + hzrd149 blossom-server + keep nostr-rs-relay for nvpn**
2. **Minimal change: nostr-rs-relay + gRPC admission plugin** (same binary, new policy) + blossom-server
3. **Club / invite community: pyramid** (only if product accepts membership)
4. **Operator vault alongside: Haven** (personal outbox/Blossom for whitelisted npubs) — complementary, not primary event home
5. **All-in-one appliance: nostrcheck-server** — only if you want NIP-05 + payments + UI and accept Node/MariaDB ops weight

### 4.2 Target policy (relay)

```
ON write(event, ip, authed_pubkey):
  if event.pubkey IN PRIVILEGED_WHITELIST:
    accept   # nvpn devices, your npubs, coordinator key(s) — any kind
  if event.kind IN EPHEMERAL_OK:  # at least 24133; full 20000–29999 OK
    accept with rate limit  # no durable store (relay native)
  if event.kind IN APP_KINDS:
    accept with rate limit
  # optional hardening:
  # if event.kind == 1059 and require_p_tag:
  #   accept only if p-tag intersects KNOWN_INBOXES or recent event pubkeys
  reject "blocked: kind not allowed on this relay"
```

**Suggested `APP_KINDS` starting set** (expand when chat/features need it):

```
0, 1, 3, 5, 6, 7,
13,              # seal (usually inside 1059; allow if ever bare)
1059,            # gift wrap
24133,           # NIP-46 (ephemeral)
10000, 10002, 10050, 10063,
30023, 30078,
30443, 443, 444, 445,   # Marmot (confirm exact set against marmot-ts)
31600-31611,     # Nostrautica addressable
31923, 31924, 31925,
24242            # only if something publishes it to relays (Blossom auth is HTTP header; usually need not store)
```

Kind **1** is optional: include if you want light social; exclude to reduce spam
(attendees can still use public relays for notes).

**Privileged whitelist:** migrate the six nvpn hex keys if this relay replaces
`nostr.cypherpunk.today`; plus operator npub(s); plus **coordinator** pubkey(s)
so the daemon can always publish directory/roster/matches.

### 4.3 Target policy (Blossom)

```
upload.requireAuth: true          # BUD-11
CORS: allow https://nostrautica.cypherpunk.today
      (and http://localhost:* for dev if needed)
MIME: allow application/octet-stream, image/*, video/* 
maxSize: e.g. 100–200 MB (intros are video)
requirePubkeyInRule: false        # open attendees
# optional soft nginx Referer check on PUT only
# optional: larger retention for coordinator/operator pubkeys via rules.pubkeys
```

Do **not** set `requirePubkeyInRule: true` unless every attendee is pre-listed.

### 4.4 URL layout on jl (example)

Keep nvpn stable; add app endpoints:

| URL | Service |
|---|---|
| `wss://nostr.cypherpunk.today` | **unchanged** nostr-rs-relay whitelist (nvpn) |
| `wss://relay.nostrautica.cypherpunk.today` or `wss://nostrautica.cypherpunk.today/relay` | strfry (or policy-enabled relay) |
| `https://blossom.nostrautica.cypherpunk.today` | hzrd149 blossom-server |

Event **31600** tags: `relay` + `blossom` point at the new pair. App defaults can
stay on public infrastructure for resilience; own pair is **home** for retention
and locality.

NIP-46: list own relay **as additional** signer relay only after verifying 24133
ephemeral path; keep `relay.nsec.app` + publics.

---

## 5. Concrete setup sketches

### 5.1 strfry write-policy plugin (sketch)

`relay.writePolicy.plugin` in `strfry.conf` → executable. Logic:

```js
#!/usr/bin/env node
const fs = require("fs");
const privileged = new Set(
  fs.readFileSync("/etc/strfry/privileged-hex-pubkeys.txt", "utf8")
    .split(/\s+/).filter(Boolean)
);
const appKinds = new Set([
  0, 3, 5, 6, 7, 13, 1059, 24133,
  10000, 10002, 10050, 10063,
  30023, 30078, 30443, 443, 444, 445,
  // 31600-31611:
  ...Array.from({ length: 12 }, (_, i) => 31600 + i),
  31923, 31924, 31925,
]);

const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.type !== "new") return;
  const ev = req.event;
  const res = { id: ev.id };
  if (privileged.has(ev.pubkey) || appKinds.has(ev.kind)) {
    res.action = "accept";
  } else {
    res.action = "reject";
    res.msg = "blocked: kind not allowed on this relay";
  }
  process.stdout.write(JSON.stringify(res) + "\n");
});
```

Enable NIP-42 in strfry (`relay.auth.enabled`, `serviceUrl = wss://…`) if you later
tighten “unknown kind 1059 must be authed”.

Also set generous `maxEventSize` / websocket payload (encrypted intros metadata
and MLS payloads can be large; NIP-44 caps ~64KiB content but tags add overhead).
Default strfry `maxEventSize = 65536` may be tight — raise toward 128–256KiB to
match nostr-rs-relay defaults if you see rejects.

### 5.2 nostr-rs-relay gRPC admission (stay-on-binary sketch)

Config:

```toml
[grpc]
event_admission_server = "http://127.0.0.1:50051"
restricts_write = true

[authorization]
# leave pubkey_whitelist unset so non-listed authors reach gRPC
nip42_auth = true
```

Implement `nauthz` proto service: same truth table as the strfry plugin.
Privileged pubkeys always admit; else kind ∈ allowlist; else deny.

nvpn can keep using a **separate** instance still on hard whitelist, or move
nvpn keys into privileged set on the unified admitter.

### 5.3 blossom-server (hzrd149) sketch

```yaml
port: 3000
host: 127.0.0.1
publicDomain: blossom.nostrautica.cypherpunk.today
database:
  path: /var/lib/blossom/sqlite.db
storage:
  backend: local
  local:
    dir: /var/lib/blossom/blobs
  rules:
    - type: "application/octet-stream"
      expiration: 1 year
    - type: "image/*"
      expiration: 1 year
    - type: "video/*"
      expiration: 1 year
    # optional operator longevity:
    # - type: "*"
    #   expiration: 5 years
    #   pubkeys: ["<hex>"]
upload:
  enabled: true
  requireAuth: true
  maxSize: 209715200  # 200 MB
  requirePubkeyInRule: false
mirror:
  enabled: true
  requireAuth: true
```

nginx:

- TLS terminate; `client_max_body_size 200m`;
- proxy to `127.0.0.1:3000`;
- CORS headers if not already from app (blossom-server sends permissive CORS by
  default in upstream — **pin down** to app origin in nginx if the daemon is too
  open for your taste):

```nginx
# illustrative — adjust to how you manage CORS (app vs nginx vs daemon)
map $http_origin $blossom_cors {
  default "";
  "https://nostrautica.cypherpunk.today" $http_origin;
  "https://nostrautica.cypherpunk.today/" $http_origin;
}
# on location /:
#   add_header Access-Control-Allow-Origin $blossom_cors always;
#   add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Content-Type, X-Content-Length, X-SHA-256" always;
#   add_header Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, OPTIONS" always;
```

Optional soft Referer filter on `PUT`:

```nginx
# weak gate — spoofable; skip if it breaks clients
if ($request_method = PUT) {
  set $ref_ok 0;
  if ($http_referer ~* "^https://nostrautica\.cypherpunk\.today") { set $ref_ok 1; }
  if ($http_origin = "https://nostrautica.cypherpunk.today") { set $ref_ok 1; }
  # if ($ref_ok = 0) { return 403; }  # enable only after testing Amber/CLI
}
```

### 5.4 Haven (if used)

Use as **operator companion**, not event home:

- `OWNER_NPUB` + `WHITELISTED_NPUBS_FILE` = you + machines that may upload personal media
- outbox/Blossom for that set
- do **not** put Haven URL alone in 31600 `relay`/`blossom` for public events

### 5.5 pyramid (if used)

- Root member = operator; invite organizers as members; organizers invite attendees
  **or** open moderated subrelay for app kinds only (check whether kind filters
  per subrelay can express 316xx/1059 — UI “allow/disallow event kinds”).
- Member Blossom quotas for intro video sizes.
- Expect product work: join-relay before join-event, or automation that invites
  on first open of event link (custom).

---

## 6. Migration plan (practical)

**Phase 0 — don’t break nvpn**  
Leave `wss://nostr.cypherpunk.today` whitelist relay as-is.

**Phase 1 — Blossom only** (fastest user-visible win)  
Run hzrd149 blossom-server on jl; put URL in event 31600 + optionally
`DEFAULT_BLOSSOM_SERVERS`. Verify: encrypted intro upload, BUD-06 preflight,
CORS from production app origin, mirror to `blossom.band` optional.

**Phase 2 — App relay with kind policy**  
Deploy strfry + plugin (or rs-relay + gRPC). Publish test 31600/1059/24133.
Point one test event’s `relay` tags at it; run coordinator against it.
Load-test gift wraps and replaceable 31603 storms.

**Phase 3 — Defaults**  
Add own relay to app defaults or onboarding NIP-65 **only after** multi-week
stability; keep public relays for partition tolerance.

**Phase 4 — Optional unify**  
If strfry privileged set includes nvpn keys and kinds are open enough for nvpn
signalling, consider retiring rs-relay — **only** after nvpn mesh verified on
the new endpoint.

---

## 7. Comparison matrix (decision view)

| Criterion | keep rs-relay whitelist | rs-relay + gRPC | strfry + plugin | Haven | pyramid | nostrcheck |
|---|---|---|---|---|---|---|
| Attendee writes | ❌ | ✅ | ✅ | ❌ outbox | ⚠️ members | ⚠️ depends config |
| Gift wrap 1059 | ❌ whitelist | ✅ | ✅ | ⚠️ chat/inbox rules | ⚠️ | ⚠️ |
| NIP-46 24133 | ❌ unknown pubkeys | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Privileged “store anything” | ✅ | ✅ | ✅ | ✅ | ✅ members | ✅ admins |
| Built-in Blossom | ❌ | ❌ | ❌ | ✅ WL only | ✅ members | ✅ |
| Anti kind-1 flood | N/A (closed) | ✅ kinds | ✅ kinds | ✅ | ✅ | ✅ |
| Ops fit on jl | already running | low+ | medium | medium | low UI | high stack |
| Active feature dev | low/stable | low/stable | active | **bugfix only** | **active** | active |
| Matches open events | ❌ | ✅ | ✅ | ❌ | weak | possible |

---

## 8. Answers to the two-part question

### What software to run?

- **Relay (Nostrautica event home):** **strfry** with a whitelist∪kind plugin,  
  **or** nostr-rs-relay **without** global whitelist plus **gRPC admission**  
  (same policy).  
- **Relay (nvpn / personal dump):** keep **nostr-rs-relay** whitelist as today,  
  **or** fold privileged keys into the new plugin.  
- **Blossom:** **hzrd149/blossom-server** (first choice; matches e2e and octet-stream  
  reality). route96 is fine if you want Rust/MySQL/payments (you already depend  
  on nostr.download publicly).  
- **Haven:** yes for a **personal vault + WL Blossom**, not as the open event relay;  
  note feature-complete / bugfix-only upstream.  
- **pyramid:** yes if you want invite-based community hosting and accept membership  
  UX; strongest “all in one” with member Blossom among fiatjaf-stack options.  
- **Avoid as sole path:** pure whitelist rs-relay, Haven outbox-only, Primal-like  
  MIME-restrictive Blossom for intros.

### How to set up with the constraints?

1. Split **privileged** vs **app** traffic in policy (not a single global whitelist).  
2. Allow **1059** and **24133** without author pre-registration.  
3. Allow **31600–31611** (+ Marmot + metadata kinds you actually publish).  
4. Rate-limit everyone; unlimited only where needed for coordinator bursts.  
5. Blossom: BUD-11 + CORS to app origin + octet-stream; Referer optional/weak.  
6. Wire URLs into kind **31600** `relay`/`blossom` tags; don’t drop public relays  
   until proven.  
7. Keep nvpn on the existing whitelist endpoint until deliberately migrated.

---

## 9. References

- Haven: https://github.com/barrydeen/haven  
  Access control: `docs/access-control.md` in that repo  
  Feature-complete note: jumble nevent in §3.1  
- pyramid: https://github.com/fiatjaf/pyramid  
  Guide: https://spatianostra.com/the-pyramid-community-relay/  
- strfry: https://github.com/hoytech/strfry  
  Plugins: `docs/plugins.md`  
- nostr-rs-relay: https://git.sr.ht/~gheartsfield/nostr-rs-relay  
  Config knobs: `config.toml` (`pubkey_whitelist`, kinds, gRPC nauthz)  
- khatru (framework): https://github.com/fiatjaf/khatru (archived) →  
  `https://pkg.go.dev/fiatjaf.com/nostr/khatru`  
- blossom-server: https://github.com/hzrd149/blossom-server  
- route96: https://github.com/v0l/route96  
- nostrcheck-server: https://github.com/quentintaranpino/nostrcheck-server  
- Comparison roundup (strfry / nostream / rs-relay):  
  https://www.pistack.xyz/posts/2026-06-06-self-hosted-nostr-relays-strfry-nostream-nostr-rs-relay/  
- Local ops: server-documentation `documentation.md`, `nostr-vpn.md`  
- App kinds: `packages/protocol/src/kinds.ts`  
- App relay defaults: `packages/app/src/lib/nostr/relays.ts`

---

## 10. Open choices (for later human decision)

1. Single host name vs separate `relay.` / `blossom.` subdomains.  
2. Whether kind **1** is allowed on the app relay.  
3. Whether gift wraps require `p`-tag ∈ known inboxes (stronger spam control,  
   more failure modes).  
4. Whether coordinator-only publishes go to privileged whitelist (yes  
   recommended).  
5. Retain Haven/pyramid later for community features without blocking Phase 1–2.

*Research date: 2026-07-24.*
