# UX Features Plan — Intro alternatives, Talks journey, AI-profile correction

Specification + phased implementation plan for three deferred UX features surfaced by
the audit (`docs/GPT56-AUDIT.md`): **U5+A1** (text/audio intro alternatives + transcript
surfacing), **U11** (prerecorded talks journey), and **U9** (AI-profile correction /
dispute / hide). This is a planning document; it defines protocol/schema changes,
coordinator changes, app components, phased build steps with file lists and acceptance
tests, cross-feature overlaps, a recommended build order, and open questions for the owner.

It builds on the shipped redesign (event-scoped `EventNav`, `event-shell` gating,
`ErrorState`, `ReadinessJourney`, i18n en+sk in one `messages.ts`) and the safe-UX work.
Cross-references into `SPECIFICATION.md` are intentionally omitted here (the owner folds
them in; concurrent doc edits in flight).

Terminology: **descriptor** = the NIP-17-kind-15-shaped media descriptor (§6.2 of the spec);
**ECK** = Event Content Key; **31603** = per-attendee Directory Entry; **21601** = Profile
Submission rumor.

---

## Ground truth (current code)

Facts the plan is built on, verified in-tree:

- **Media is video-only, two roles.** `mediaDescriptorSchema` (`packages/protocol/src/schemas.ts:49`)
  is `.strict()` with `kind: z.enum(["intro","talk"])`, plus `url`, `x` (ciphertext sha256),
  `ox` (plaintext sha256), `size`, `m` (mime), `duration?`, and the AES-GCM key/nonce fields.
  There is **no media-type axis** — audio vs video is only distinguishable by the `m` mime.
- **Submission** (`profileSubmissionContentSchema`, 21601): `{ v, profile, media[] }`.
  `AttendeeProfile = { about, skills[], looking_for, links[] }`. No free-text intro field.
- **Recorder** (`packages/app/src/lib/pages/Record.svelte`) is a single-flow video recorder;
  `kind = talk ? "talk" : "intro"`, `maxSec = talk ? maxTalkSec : maxVideoSec`. Capture is
  `VideoCapture` (`media/capture.ts`) with a client-side hard-stop; there is no server-side
  duration check. Pre-submit **disclosure card** (H10) already exists (`record.disclosure.*`,
  gates every submit via `disclosureAck`).
- **Pipeline** (`packages/coordinator/src/pipeline/`): `transcribe.ts` downloads the blob
  (SSRF-guarded, 200 MB cap), decrypts, `audio.ts` extracts mono-16 kHz Opus with ffmpeg and
  **segments long media** (`extractAudioSegments`), STT (`VeniceStt`, 25 MB/segment) →
  transcript. Transcripts are cached in the `transcripts` table keyed by `blob_sha256` (= `x`)
  and **never published** — they are an intermediate consumed only by `buildAiProfile`.
  `process.ts` transcribes **all** media regardless of `kind`, so a submitted talk already
  feeds the ai_profile today (spec §9.2) — no pipeline change needed for that.
- **ai_profile** (`profile.ts`): `buildAiProfile` → `{ summary, skills[], interests[],
  offers[], seeks[], translations? }`, content-addressed artifact keyed by
  `profileInputsHash(inputs, modelKey)` in `pipeline_artifacts (stage, inputs_hash)`.
- **Directory entry** (31603, `nostr/publisher.ts:buildDirectoryEntry` + `coordinator.ts:publishDirectory`):
  ECK-encrypted `{ v, pubkey, profile, media, ai_profile?, updated_at }`, blinded `d`.
  `ai_profile` is included **only when fresh**: `aiFresh = ai_profile_json && (!source_revision
  || ai_source_revision === source_revision)` (`coordinator.ts:553-563`). This staleness gate
  is the exact hook a hide/override feature extends.
- **Dispatch** (`coordinator.ts`): `handleCoordinatorWrap` (to coordinator pubkey) handles
  21603/21604; `handleInboxWrap` (to E_inbox) handles 21600/21601. Admin commands
  (`approve|recompute|reprocess|revoke`) are sealed by `E_id`.
- **Nav**: `EventNav.svelte` (Overview · People · Matches · Updates · More). Tab gating is the
  `event-shell.svelte.ts` `get showPeople()` / `get showMatches()` pattern + `{#if}` in
  `EventNav`. Layout picks `EventNav` vs global `BottomNav` on `eventNaddr(route)`.
- **Attendee display** (`Attendee.svelte`): renders `media.filter(m => m.kind === "intro")`
  through `MediaPlayer` — **talks are dropped here today**; shows only `ai_profile.summary`
  (skills/interests/offers/seeks are not surfaced). `MediaPlayer.svelte` suppresses the
  missing-caption a11y warning and has **no transcript UI**.
- **Config** (`config.ts`, kind 31600): tags parsed = `d, inbox` (required), `coordinator?`,
  `relay[]`, `blossom[]`, `max_video_sec` (90), `max_talk_sec` (900), `matching` (off),
  `match_visibility` (pair), `approval` (manual), `eck` (1), `nostr_context` (0), `lang` (en).
  New tags follow the `lang` idiom: **omit when default** so existing events stay byte-identical.
- **Kinds**: addressable **31600–31609 fully allocated**; rumors **21600–21606** (21606 =
  Coordinator Status). `ErrorState.svelte` exists (`{ error, onRetry?, retrying? }`) but
  Record/MediaPlayer still use ad-hoc warn cards. `docs/MARMOT-GROUP-CHAT.md` **does not
  exist yet** (being written concurrently; adds a `chat` tag on 31600 + coordinator admin-bot).

---

## FEATURE 1 — Text / audio intro alternatives + transcript surfacing (U5 + A1)

**Goal.** An attendee can submit an intro as **(a) text**, **(b) audio-only**, or
**(c) video** (today's path). The matching pipeline handles all three: text skips STT
entirely, audio runs STT only, video runs today's ffmpeg-extract → STT. Separately, **every**
intro (especially video) gains a text consumption path — a published transcript with a
caption/transcript toggle on playback — so a deaf or screen-reader attendee can consume any
intro. This is the A1 WCAG-2.2-AA "nonvisual consumption path" requirement.

### 1.1 Protocol / schema changes

The media-type axis is added **without** widening the `kind` enum (which stays the
intro-vs-talk *role* axis). Media type is carried by the existing `m` mime; text has no blob.

- **`mediaDescriptorSchema`** — no structural change required for audio (audio = `kind:"intro"`,
  `m:"audio/ogg"` or `audio/webm`). Keep `.strict()`. Playback branches on `m` (`<audio>` vs
  `<video>`).
- **`profileSubmissionContentSchema`** (21601) — add optional **`intro_text?: string`**
  (bounded, e.g. ≤ 2 000 chars; validated, plain text). Text-only intro: `intro_text` set,
  `media` empty. Audio/video: `media` set, `intro_text` absent.
- **`directoryEntryContentSchema`** (31603) — add optional **`transcripts?: MediaTranscript[]`**
  and optional **`intro_text?: string`** (echoes the authored text for display). New sub-schema:
  ```
  MediaTranscript = {
    x: hex32,                 // descriptor.x this transcript belongs to (media ref)
    text: string,
    lang: string,             // ISO-639-1 detected by STT, or authored source lang
    source: "stt" | "authored",
    updated_at: number
  }
  ```
  Validate that every `transcripts[i].x` matches a `media[j].x` in the same entry (stale
  transcripts for replaced media are dropped — the `x` is content-addressed, so a re-record
  changes `x` and orphans the old transcript).
- **`AttendeeProfile`** — unchanged. `intro_text` is deliberately *not* an authored-identity
  field; it is intro content (feeds STT-equivalent path), kept separate so Feature 3's "You
  wrote" identity fields stay distinct.
- Version: all payloads keep `v:1`; new fields are additive-optional, so old readers ignore
  them and old coordinators simply never populate them.

### 1.2 Coordinator changes

- **`handleSubmission`** (`coordinator.ts`): thread `intro_text` through alongside `media`
  (currently stashes `{...profile, __media: media}`; add `__intro_text`).
- **`process.ts`**: build `transcripts[]` from three sources, each tagged with an `x` (for the
  media-derived ones) or a synthetic ref for authored text:
  - **video**: unchanged — ffmpeg-extract → STT, `source:"stt"`.
  - **audio**: skip ffmpeg-extract's video path; `extractAudioSegments` already accepts audio
    input (it normalizes any mime to Opus). `source:"stt"`.
  - **text** (`intro_text`): **no STT** — the authored text *is* the transcript,
    `source:"authored"`, and is fed directly into `buildAiProfile`'s transcript block.
  Guard: `buildAiProfile` must not require a media descriptor — a text-only attendee has
  `media:[]` and still produces an ai_profile. (Today `enqueueProcess` is skipped when
  `matching==="off"`; unchanged.)
- **`publishDirectory`**: attach `transcripts[]` (STT text per media `x` + the authored text)
  and `intro_text` to the 31603 content. Only attach transcripts whose `x` is still present in
  the current `media[]` (staleness rule above).
- STT artifact keying is already content-addressed by `x`; authored text needs no artifact.

### 1.3 App changes — tabbed composer + transcript display

- **Recorder → composer** (`Record.svelte`, `media/capture.ts`): refactor into the staged
  flow from audit P2.8 (`choose → preview/check → countdown → record → review → uploading →
  submitted`) with a **mode tab bar: Video · Audio · Text**.
  - **Video**: today's path + `facingMode:"user"`, camera enumeration/switch, live mic meter,
    3-second countdown, `Choose video` file fallback.
  - **Audio**: `getUserMedia({audio:true})`, mic meter, same countdown/hard-stop, waveform or
    timer; produces an audio blob (reuse `VideoCapture` with an audio-only `MediaRecorder`
    mime ladder: `audio/webm;codecs=opus` → `audio/ogg;codecs=opus` → `audio/webm`).
  - **Text**: a bounded textarea → `intro_text` (no blob, no upload). Shows the character
    budget and the same disclosure gate.
  - `uploadMedia(signer, ctx, blob, kind, durationSec)` already produces a descriptor from any
    blob/mime, so audio needs no upload-path change (it AES-GCM-encrypts + BUD-02/04 mirrors
    identically). Text bypasses upload entirely and calls `submitProfileAndMedia` with
    `media:[]` + `intro_text`.
  - **Disclosure**: extend the existing card — text intro drops the STT/provider bullet
    (no audio leaves the device for STT; the match model still sees the text). Add a per-mode
    disclosure variant key.
  - Convert Record's ad-hoc warn card to `ErrorState`; add specific permission-denied /
    no-device / unsupported-browser copy (P2.8), never re-prompting.
- **`submit.ts`**: `submitProfileAndMedia` gains an optional `introText` that is written into
  the 21601 content and the 31602 self-copy (so the attendee's own device keeps its text).
- **Transcript display** (`MediaPlayer.svelte`, `Attendee.svelte`): the player takes an
  optional `transcript?: MediaTranscript` prop; adds a **"Show transcript"** toggle, a
  machine-generated label when `source==="stt"`, and a decrypted/local `<track kind="captions">`
  when a WebVTT descriptor is available (WebVTT generation is optional/phase-2 — see open
  questions; the transcript text toggle is the mandatory nonvisual path). Replace the
  suppressed-caption a11y warning with a truthful `Captions unavailable` / transcript-available
  status. For a **text intro**, `Attendee.svelte` renders `intro_text` as the primary content
  (no player).
- **i18n**: `record.mode.{video,audio,text}`, `record.audio.*`, `record.text.*`,
  `record.disclosure.confirmText`, `media.showTranscript`, `media.transcript.machine`,
  `media.captionsUnavailable`, plus sk.

### 1.4 Phases (Feature 1)

| Phase | Scope | Files | Size |
|---|---|---|---|
| **F1.1 — Directory-entry + submission schema** | Add `intro_text` (21601, 31603) + `MediaTranscript[]` (31603) with the `x`-matches-media validation. *Shared foundation with F3 — do once.* | `packages/protocol/src/schemas.ts`, `packages/protocol/src/*` tests | S |
| **F1.2 — Coordinator transcript publish + text/audio branch** | `handleSubmission` threads `intro_text`; `process.ts` builds `transcripts[]` (stt/authored) and skips STT for text; `publishDirectory` attaches transcripts + `intro_text` with staleness filter. | `coordinator.ts`, `pipeline/process.ts`, `pipeline/profile.ts`, `nostr/publisher.ts` | M |
| **F1.3 — Transcript display** | `MediaPlayer` transcript toggle + machine label + caption track hook; `Attendee.svelte` renders text intros and passes transcripts; remove suppressed warnings. | `components/MediaPlayer.svelte`, `pages/Attendee.svelte`, `i18n/messages.ts` | M |
| **F1.4 — Tabbed composer (video/audio/text)** | Staged Record flow, audio capture, text composer, file fallback, facingMode/camera-switch/mic-meter, per-mode disclosure, ErrorState. | `pages/Record.svelte`, `media/capture.ts`, `media/submit.ts`, `i18n/messages.ts` | L |

**Acceptance tests (F1)**
- A user with camera denied can submit a **text** intro and appears in the directory with an
  ai_profile derived from that text (no STT called).
- An **audio-only** intro round-trips: encrypted blob uploaded, STT transcript published,
  playable via `<audio>` with a working "Show transcript" toggle.
- A **video** intro shows a machine-generated transcript; a screen-reader user can read it.
- Re-recording changes `x`; the stale transcript is not shown for the replaced media.
- Both locales; axe passes on the composer and player; review survives an upload failure.

### 1.5 Open questions (F1)
- **WebVTT timed captions vs plain transcript text.** Plain transcript is mandatory and cheap;
  timed VTT needs word-timestamps from STT (Venice whisper can, at extra plumbing). Ship plain
  first, VTT as a follow-up? (Recommend yes.)
- **`intro_text` length cap** and whether it also feeds `nostr_context`-style summarization or
  goes verbatim into the transcript block (recommend verbatim, capped ~2 000 chars).
- **Audio blob mime** for widest interop (Safari records `audio/mp4`; ffmpeg handles it, but
  confirm the mime ladder).

---

## FEATURE 2 — Prerecorded talks journey (U11)

**Goal.** A complete, **config-gated** talks lifecycle: enable at event creation → submit a
talk (longer media, `max_talk_sec` + segmentation) → discover in a gated **Talks** nav
destination → watch (playback + transcript/captions) → talks feed matching (already true).
Normal conferences (talks off) show **no** Talks navigation and no talk step — this is the
hard requirement. One supported format is *prerecord-first* (talks watched ahead, venue for
conversation) where Talks is featured prominently.

### 2.1 Protocol / schema changes

- **31600 config** — add a **`talks`** tag: `"off"` (default, omitted) | `"on"` |
  `"prerecord-first"`. Follow the `lang` idiom (omit when `off`). Add `talks` to `EventConfig`,
  `buildEventConfig` (push only when ≠ off), `parseEventConfig` (enum-with-fallback → `off`).
  `off` = no talk UI anywhere; `on` = Talks available; `prerecord-first` = Talks featured
  before People in nav order.
- **Talk artifact — recommended new addressable kind `31610` "Talk"** (author = coordinator, or
  `E_id` when no coordinator; ECK-encrypted; blinded `d` per talk, e.g. over
  `speaker_pubkey|talk_d`). Content:
  ```
  {
    v: 1,
    pubkey: <speaker hex>,
    title, description,
    speakers: [<hex>...],           // usually [pubkey], allows co-speakers
    media: <descriptor kind:"talk">,
    transcript?: MediaTranscript,   // reuses F1's sub-schema
    lang, revision, status: "pending"|"published"|"rejected",
    published_at
  }
  ```
  Rationale (audit U11): keeps talk artifacts/jobs **distinct** from intros, supports organizer
  moderation/publication (`status`), and revisioning (editing = new `revision`, last published
  preserved until replacement succeeds). Discovery = query `{kinds:[31610], authors:[coordinator/E_id]}`
  — scoped by the per-event author key.
  **Caveat:** 31600–31609 is the "reserved block" and is fully allocated; 31610 extends past it
  and needs a NIPs-registry re-check (spec §15 tracks this). See open questions for the
  lighter-weight alternative.
- **Submission of talks.** Two viable channels (owner decision, open question):
  - *(A, recommended)* new rumor **`21607` "Talk Submission"** (attendee → `E_inbox`),
    `{ v, a, title, description, speakers[], media: descriptor(kind:"talk"), revision }`.
    Keeps talk intake off the intro submission path.
  - *(B, minimal)* keep talks inside the existing 21601 `media[]` (kind `"talk"`) and add
    talk metadata (title/description) as optional descriptor fields. Cheapest, but pollutes the
    NIP-17-shaped descriptor and gives no independent status/moderation.
  Recommendation: **B for the config-gate MVP (P4.3), A+31610 for the full journey.**

Note the rumor-kind collision risk: **Feature 3 also wants 21607.** If both land, assign
21607/21608 in build order (see cross-feature section) — whichever ships first takes 21607.

### 2.2 Coordinator changes

- **Talk intake**: if channel A, add `KIND_TALK_SUBMISSION` to `handleInboxWrap` dispatch;
  validate sender is an approved attendee; store a talk row (new `talks` table:
  `coordinate, talk_d, pubkey, title, description, media_json, transcript, revision, status`).
- **Transcription reuses the existing pipeline unchanged** — talks already transcribe via
  `process.ts` (all `media`), `audio.ts` already segments long talks (`extractAudioSegments`,
  the 25 MB/segment path). For a dedicated 31610 artifact, add a `process_talk` job that
  transcribes the talk media and publishes/updates 31610; the transcript still folds into the
  speaker's ai_profile only if `talks` matching opt-in is set (audit: "do not send talks into
  matching unless config explicitly opts in" — but current code already folds all media; see
  open question on whether to gate that).
- **Moderation**: organizer `approve/reject` of a talk via a new admin sub-command (extend
  `adminCommandContentSchema` enum with `talk_publish` / `talk_reject`, sealed by `E_id`), or
  the organizer client publishes 31610 directly when no coordinator. Editing bumps `revision`
  and preserves the last published 31610 until the new one publishes.

### 2.3 App changes

- **Enable at creation** (`Create.svelte`, `events/create.ts`): a "Prerecorded talks" toggle
  (off / on / prerecord-first) writing the `talks` tag; expose the currently-hardcoded
  `maxTalkSec` input when talks are on. Mirror in `Admin.svelte` (edit config).
- **Nav gating** (`event-shell.svelte.ts`, `EventNav.svelte`): add `get showTalks()` gated on
  `ctx.config.talks !== "off"` — exactly the `showMatches` pattern. Add a **Talks** destination
  (new `talks` list route + `talk` detail route in `routes.ts`, plus the `eventNaddr` set and
  icon). In `prerecord-first`, order Talks before People. When `off`, the tab and the
  `?talk=1` record entry are hidden entirely.
- **Submit/edit a talk**: reuse the F1 staged composer in talk mode (already `?talk=1`,
  `maxSec = maxTalkSec`); add title/description/speakers fields. Gate the entry behind
  `showTalks`.
- **Discover + watch**: new `Talks.svelte` (list from 31610 query / talks table) and a talk
  detail view; **watch reuses `MediaPlayer` + `playback.ts` unchanged** (kind-agnostic;
  decryption keys ride in the descriptor). Add transcript/captions from F1.3. Per-identity
  **watch progress** stored locally / self-encrypted (30078 app-data or a device-local store) —
  no new published kind.
- **Accessibility/limits/abuse** inherit from intros: same disclosure, text/audio alternative
  where meaningful, media limits, mute/report, retention.

### 2.4 Phases (Feature 2)

| Phase | Scope | Files | Size |
|---|---|---|---|
| **F2.1 — Config gate (P4.3 minimum)** | `talks` tag in 31600 (off default); hide talk record mode + `?talk=1` route + any talk UI when off; creation/admin toggle; `maxTalkSec` input. | `packages/protocol/src/config.ts`, `pages/Create.svelte`, `events/create.ts`, `pages/Admin.svelte`, `lib/router/routes.ts`, `pages/Record.svelte`, coordinator config parse | S–M |
| **F2.2 — Talks nav destination + basic watch** | `showTalks` on event-shell; Talks tab in EventNav (order per mode); `Talks.svelte` list + talk detail reusing MediaPlayer; surface `kind:"talk"` media (today dropped in Attendee). Minimal channel-B intake (talks in 21601 media). | `stores/event-shell.svelte.ts`, `components/EventNav.svelte`, `lib/router/routes.ts`, new `pages/Talks.svelte`, `pages/Attendee.svelte`, `components/icons/`, `i18n/messages.ts` | M |
| **F2.3 — Talk artifact + submission (full journey)** | New kind `31610` (+ registry re-check), `21607` talk submission (or channel B fields), talks table, `process_talk` job, organizer moderation admin sub-command, revisioning. | `packages/protocol/src/kinds.ts`, `schemas.ts`, `coordinator.ts`, `pipeline/*`, `nostr/publisher.ts`, `store/db.ts` | L |
| **F2.4 — Watch progress + captions + edit/replace** | Self-encrypted watch progress; transcript/captions on talk playback (from F1.3); edit/replace with revision preservation; talk submit composer fields. | `pages/Talks.svelte`, talk detail, `stores/*`, `pages/Record.svelte`, `i18n/messages.ts` | M–L |

**Acceptance tests (F2)**
- Talks **off** (default): no Talks tab, no talk record entry, journey identical to today.
- Talks **on**, empty: Talks tab present, empty state, joining/intros unaffected.
- Talks **on**, populated: a submitted talk is discoverable, plays with transcript, and
  (per config) folds into the speaker's ai_profile.
- `prerecord-first`: Talks featured before People; still non-blocking for join/intro.
- Editing a talk creates a new revision; the last published revision stays watchable until the
  new one publishes; duplicate uploads (same content hash) are idempotent.

### 2.5 Open questions (F2)
- **New kind 31610 vs piggyback.** Accept extending the reserved block past 31609 (registry
  re-check), or keep talks inside per-attendee 31603 `media[]` + a talk-meta block (no new kind,
  weaker moderation/status)? Recommend the dedicated kind for the full journey.
- **21607 assignment** — shared with Feature 3 (Profile Correction). Which feature takes 21607?
- **Matching opt-in for talks.** Audit says don't feed talks into matching unless config opts
  in, but current code already folds *all* media transcripts into the ai_profile. Add a
  `talks_matching` sub-flag and actually gate it, or accept current always-on behavior?
- **Watch-progress storage** — device-local only, or self-encrypted 30078 for cross-device?

---

## FEATURE 3 — AI profile correction / dispute / hide (U9)

**Goal.** An attendee can **view** their own generated ai_profile, **correct/override**
specific fields, or **hide** the ai_profile entirely (falling back to their self-authored
profile). The signal is an authenticated attendee→coordinator rumor the coordinator honors
when publishing 31603, and — critically — **survives reprocessing**: after a fresh ai_profile
is generated, the stored override is re-applied.

### 3.1 Protocol / schema changes

- **New rumor kind `21607` (or `21608`) "Profile Correction"** (attendee → coordinator pubkey;
  gift-wrapped; when no coordinator → `E_inbox`, organizer applies). Content:
  ```
  {
    v: 1,
    a: <coordinate>,
    source_revision: <ai_source_revision being corrected>,  // optimistic-concurrency ref
    hidden: boolean,                    // true = publish 31603 with NO ai_profile
    overrides?: {                       // per-field overrides of generated ai_profile
      summary?: string,
      skills?: string[], interests?: string[],
      offers?: string[], seeks?: string[]
    },
    hidden_fields?: (keyof ai_profile)[],   // fields to blank rather than override
    report?: { category: string, text?: string }   // optional "this is inaccurate" dispute
  }
  ```
  Sealed by the attendee's own key; the coordinator validates **seal author === subject
  pubkey** (rejects spoofed corrections). Additive-optional; `v:1`.
- **31603 directory entry** — no schema change needed for hide (omit `ai_profile`); overrides
  are applied *into* the existing `ai_profile` object before publish, so readers see one
  merged profile. Optionally add a boolean **`ai_profile_edited?: boolean`** so viewers can be
  told fields were corrected by the subject (transparency). The authored `profile` fields are
  never rewritten by a correction (identity stays authored).

### 3.2 Coordinator changes

- **Dispatch**: add `KIND_PROFILE_CORRECTION` to `handleCoordinatorWrap` (and the E_inbox path
  when no coordinator). Validate sender == subject.
- **Storage**: new `attendees` columns `correction_json` + `correction_source_revision` (the
  override survives DB as it is authoritative until the attendee changes it).
- **Apply on publish** (`publishDirectory`): after computing `aiFresh`:
  - if `correction.hidden` → publish 31603 **without** `ai_profile` (self-authored fallback);
  - else merge `overrides` over the generated `ai_profile`, blank `hidden_fields`, set
    `ai_profile_edited`.
- **Survive reprocessing**: `processAttendeeJob` re-generates `ai_profile` and calls
  `publishDirectory`; because overrides live in `attendees.correction_json` (not in the
  content-addressed `pipeline_artifacts`), they are re-applied automatically on every publish.
  The `correction_source_revision` enables optimistic handling: if a *newer* ai_profile
  revision arrives, keep the user's overrides (audit: "preserve newer user overrides, mark
  conflicts for review") — an override on a field the model has since changed is flagged, not
  silently dropped.
- **Reports**: forward only privacy-safe metadata to the organizer (category + optional text
  the attendee explicitly shares); do **not** expose pair-private match reasoning. Reuse the
  21606 Coordinator-Status → organizer channel, or a minimal report forward. (Full
  report-to-organizer moderation queue is audit U10/Q5 — out of scope here.)

### 3.3 App changes — self-view + edit + hide

- **New "My event profile" surface.** No self ai_profile editor exists today. Add a
  `myProfile` event route (reachable from `EventMore` and from `ReadinessJourney`'s
  "processed" step). It renders the attendee's own 31603 with two clearly separated regions:
  **"You wrote"** (authored `profile`: about/skills/looking_for/links — editable only via the
  normal submission flow) and **"Generated from your intro"** (`ai_profile`: summary + the
  skills/interests/offers/seeks that `Attendee.svelte` doesn't currently show).
- **Edit**: inline edit of each generated field → builds a Profile Correction rumor with
  `overrides`. **Hide**: a toggle → `hidden:true` (falls back to authored profile everywhere).
  **"This is inaccurate"**: a report with category + optional text.
- **Attendee.svelte**: surface the full ai_profile fields (not just summary) and, when
  `ai_profile_edited`, a subtle "edited by attendee" marker.
- Optimistic UI with the `source_revision` check; `ErrorState` for failures; both locales
  (`profile.mine.*`, `profile.edit.*`, `profile.hide.*`, `profile.report.*`).

### 3.4 Phases (Feature 3)

| Phase | Scope | Files | Size |
|---|---|---|---|
| **F3.1 — Correction rumor + schema** | New rumor kind + `profileCorrectionContentSchema`; optional `ai_profile_edited` on 31603 (shares F1.1's directory-entry edit). | `packages/protocol/src/kinds.ts`, `schemas.ts`, tests | S–M |
| **F3.2 — Coordinator honor + survive-reprocess** | Dispatch + sender validation; `correction_json` columns; `publishDirectory` merge/hide; re-apply after reprocess with optimistic revision check; privacy-safe report forward. | `coordinator.ts`, `store/db.ts`, `nostr/publisher.ts` | M–L |
| **F3.3 — Self-view + edit + hide UI** | `myProfile` route + page; "You wrote" vs "Generated"; per-field edit → override rumor; hide toggle; inaccurate report; surface full ai_profile on Attendee.svelte. | new `pages/MyProfile.svelte`, `pages/EventMore.svelte`, `pages/Attendee.svelte`, `components/ReadinessJourney.svelte`, `lib/router/routes.ts`, `i18n/messages.ts` | M–L |

**Acceptance tests (F3)**
- A subject sees their generated fields and corrects `summary`; the corrected text publishes in
  31603 and shows to others; authored identity fields are untouched.
- **Hide** → 31603 publishes with no `ai_profile`; the roster/matches fall back to authored
  profile; re-enabling restores it.
- A `reprocess` regenerates the ai_profile; the stored override is **re-applied** (not lost),
  and a conflicting override on a since-changed field is flagged, not dropped.
- A spoofed correction (seal author ≠ subject) is rejected.
- A report reaches the organizer as category-only metadata; pair-private reasoning is not
  exposed.

### 3.5 Open questions (F3)
- **21607 vs 21608** — shared numbering with Feature 2's talk submission (see cross-feature).
- **Report routing** — piggyback 21606 to organizer, or defer report-to-organizer entirely to
  U10/Q5? (This spec assumes minimal category-only forward.)
- **Conflict UX** — when the model changes a field the attendee had overridden, show a "review
  updated" prompt, or silently keep the override until the attendee revisits?
- **Where "My event profile" lives** — dedicated `myProfile` route (recommended) vs a mode of
  `Attendee.svelte` viewing one's own npub.

---

## Cross-feature overlap & recommended build order

### Shared files (all three touch these — coordinate edits to avoid churn)

| Surface | F1 | F2 | F3 | Note |
|---|---|---|---|---|
| `protocol/src/schemas.ts` (31603 content) | transcripts + intro_text | (talk transcript reuses `MediaTranscript`) | `ai_profile_edited` | **Do the 31603 content-schema edit once** in a shared foundation step. |
| `protocol/src/config.ts` (31600 tags) | — | `talks` tag | — | Overlaps **Marmot's `chat` tag** — same three edit sites (interface/build/parse). |
| `protocol/src/kinds.ts` (rumor kinds) | — | 21607 talk submission | 21607/21608 correction | **Assign 21607/21608 in one pass** to avoid a collision. |
| `coordinator.ts` (`publishDirectory`) | attach transcripts | (talk artifact separate) | merge/hide overrides | Both F1 and F3 mutate the same publish function — sequence them. |
| `coordinator.ts` dispatch switch | — | talk intake case | correction case | Overlaps **Marmot** (coordinator gains cases too). |
| `pipeline/process.ts` / `profile.ts` | text/audio branch | (reuses, unchanged) | (unchanged) | F1 owns the pipeline edit. |
| `pages/Record.svelte` + `media/capture.ts` | tabbed composer | talk mode reuses composer | — | **F1 refactors the recorder; F2 depends on that refactor.** |
| `EventNav.svelte` + `event-shell.svelte.ts` | — | `showTalks` + Talks tab | — | Overlaps redesign; F2 adds a getter in the `showMatches` idiom. |
| `pages/Attendee.svelte` | text intro + transcript | surface talk media | full ai_profile fields | Three separate edits to the same file — batch or sequence. |
| `i18n/messages.ts` (en+sk) | record modes, transcript | talks, watch | my-profile, edit, hide | Additive; low conflict but same file. |

### Overlap with the concurrent Marmot group-chat feature (`docs/MARMOT-GROUP-CHAT.md`)

Marmot is being written by another agent and is currently absent from the tree. Two concrete
collision points:

1. **31600 config tags.** Marmot adds a `chat` tag (`"nip17"`/`"marmot"`); Feature 2 adds a
   `talks` tag. Both edit the same three sites in `config.ts` (interface, `buildEventConfig`,
   `parseEventConfig`) and both must use the **omit-when-default** idiom (like `lang`) so
   existing 31600 events stay byte-identical. Land them in one config PR or explicitly rebase
   the second onto the first — do not let two agents edit `parseEventConfig` blind.
2. **Coordinator dispatch + admin bot.** Marmot makes the coordinator an MLS admin bot with its
   own gift-wrap handling; Feature 3 (correction) and Feature 2A (talk submission) each add a
   dispatch case. The `handleCoordinatorWrap` / `handleInboxWrap` switches and the
   `adminCommandContentSchema` enum are shared edit points — coordinate rumor-kind numbers
   (Marmot may also claim a rumor kind) and the admin-command enum additions across all four
   workstreams. **Reserve the rumor-kind range up front** (21607, 21608, … ) so no two features
   claim the same number.

### Recommended overall build order

```
0. SHARED FOUNDATION  (S)   protocol 31603 content-schema edit (F1.1 ∪ F3.1) +
                            rumor-kind assignment (21607/21608) + config-tag idiom.
                            One PR, so schema churn happens once.

1. FEATURE 1  (M+M+L)       Text/audio intro + transcript surfacing.
   F1.2 → F1.3 → F1.4       First because: it is the accessibility-critical path (A1/U5),
                            it refactors Record.svelte into the staged composer that F2
                            reuses, and it establishes transcript publish/display that both
                            F2 (talk captions) and F3 (self-view) build on.

2. FEATURE 3  (S/M/L)       AI-profile correction/hide.
   F3.2 → F3.3              Depends on the shared 31603 edit and on Attendee.svelte/self-view
                            surfaces; independent of the recorder, so it can proceed in
                            parallel with F1.4 once F1.2's publishDirectory lands.

3. FEATURE 2  (config gate early, full journey last)
   F2.1 (anytime, early)    Ship the talks CONFIG GATE first and independently (P4.3) — it is
                            small and keeps normal conferences clean regardless of the rest.
   F2.2 → F2.3 → F2.4       Full journey last: largest, optional/gated, and it reuses the F1
                            composer + F1.3 transcript display + kind-agnostic MediaPlayer.
```

Rationale: the recorder refactor (F1.4) and the transcript pipeline (F1.2/F1.3) are the widest
shared dependencies, so Feature 1 goes first. Feature 3 shares only the 31603 schema +
Attendee.svelte and is otherwise independent, so it slots second (partly parallel). Feature 2
is the biggest and most reuse-heavy, so it goes last — except its config gate, which is tiny
and should land early to protect the normal-conference journey immediately.

---

## Consolidated protocol additions

| Feature | New kinds | New 31600 tags | New rumor content / schema | New 31603 fields |
|---|---|---|---|---|
| **F1** | — | — | 21601: `intro_text?`; `MediaTranscript` sub-schema | `transcripts?: MediaTranscript[]`, `intro_text?` |
| **F2** | **31610 Talk** (recommended; registry re-check) | **`talks`** (`off`\|`on`\|`prerecord-first`) | **21607** Talk Submission (channel A) *or* talk-meta on descriptor (channel B); admin `talk_publish`/`talk_reject` | (talk lives in 31610, not 31603) |
| **F3** | — | — | **21607/21608** Profile Correction (`overrides`, `hidden`, `hidden_fields`, `report`) | `ai_profile_edited?` |

Rumor-kind numbering to resolve up front (with Marmot in the mix): current max is **21606**.
Candidates 21607 / 21608 are contended by F2 (talk submission) and F3 (correction) and possibly
Marmot — assign them in the shared foundation step.

---

## Consolidated open questions for the owner

1. **Talk artifact model (F2):** dedicated kind **31610** (extends the reserved 31600–31609
   block, needs a NIPs-registry re-check) for real moderation/status/revisioning, or piggyback
   talks inside per-attendee 31603 `media[]` with no independent status? (Recommend 31610 for
   the full journey; channel-B piggyback for the MVP gate.)
2. **Rumor-kind assignment:** F2 talk submission and F3 correction both want the next rumor kind.
   Confirm 21607 = Profile Correction, 21608 = Talk Submission (or the reverse), and reserve a
   number for Marmot if it needs one.
3. **Talks → matching (F2):** the pipeline already folds *all* media transcripts (including
   talks) into the ai_profile. Add a `talks_matching` opt-in sub-flag and actually gate it (per
   audit U11), or accept the current always-on behavior?
4. **Timed captions vs plain transcript (F1/A1):** ship plain transcript text now (mandatory
   nonvisual path) and defer WebVTT word-timed captions to a follow-up, or require VTT in the
   first cut?
5. **Report-to-organizer (F3/U9 + U10):** minimal category-only forward via the existing 21606
   organizer channel, or defer disputes-to-organizer entirely until the U10/Q5 moderation-queue
   decision?
6. **Override conflict UX (F3):** when reprocessing changes a field the attendee had overridden,
   show a "review updated field" prompt, or keep the override silently until the attendee
   revisits?
7. **`intro_text` handling (F1):** verbatim into the transcript block (recommended) with a
   ~2 000-char cap, or summarize it like nostr-context first?
8. **Watch-progress storage (F2):** device-local only, or self-encrypted 30078 for cross-device
   resume?
9. **Config-tag coordination with Marmot:** land `talks` (F2) and `chat` (Marmot) in a single
   `config.ts` change to avoid two agents editing `parseEventConfig` blind — confirm ownership.
