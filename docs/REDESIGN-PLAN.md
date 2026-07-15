# Nostrautica UI Redesign — Implementation Plan

> **STATUS 2026-07-15: IMPLEMENTED (in the working tree, not yet committed).** All seven
> phases landed and were verified in a live browser run — see
> [`FEATURE-VERIFICATION-2026-07-15.md`](FEATURE-VERIFICATION-2026-07-15.md) §7. Delivered:
> event-scoped bottom nav (`EventNav.svelte`), Overview readiness journey
> (`ReadinessJourney.svelte` + `events/readiness.ts`), confidence-first Matches
> (`events/confidence.ts` + `ConfidenceBadge.svelte`), People roster with search/filter +
> initial avatars + `PersonCard.svelte`, the monochrome icon set (`components/icons/`, no
> calendar/clock), the event colour wash + serif titles, and theme-color sync. Two items
> from this plan are only **partially** done: the `Admin.svelte` split into
> `lib/pages/admin/*` subcomponents did **not** happen (still a 1064-line monolith) and the
> distinct "Health" section never materialized (§9/§10 here) — the operations-first
> *reorder* did ship. This plan is kept for provenance; do not delete it. Everything below
> is the original plan text as approved.

**Date:** 2026-07-15 · **Status:** approved by owner, full scope · **Executor:** implementation agent
**Source of truth for visuals:** the approved mockups
(`redesign-mockups.html` in the session scratchpad — the token values, phone frames, icon shapes,
readiness stepper, confidence treatment, and event header in that file are the target).
**Source of truth for IA and behavior:** `docs/GPT56-AUDIT.md` — "Design direction",
"Recommended event participant information architecture", "Recommended organizer information
architecture", findings U1/U3/U6/U7/A2/A6/A7, and plan steps P2.6, P2.7, P3.5, P3.6 in the
appended "Implementation plan (2026-07-15)".

This plan turns the mockups into concrete, per-file work. It is ordered so every phase is
independently shippable, and it builds ON the safe-UX work already in the working tree
(see §13, the reuse/supersede ledger) — do not reimplement or clobber that work.

---

## 1. Hard constraints (read before writing any code)

1. **Extend the token system in `packages/app/src/lib/styles/app.css` — never fork it.**
   All new colors/gradients/typography are new custom properties in the existing
   `:root`, `:root, [data-theme="dark"]`, and `[data-theme="light"]` blocks. No second
   stylesheet layer, no component-local hex values for anything semantic.
2. **The event colour wash sits UNDER the organizer's custom CSS (spec §7.4, kind 31609).**
   The theme injector (`lib/events/theme-injector.ts`) appends `<style data-event-theme>` to
   `<head>`. Everything this redesign injects must come *earlier in the cascade* than that
   element so an organizer's 31609 CSS can override it. Concretely: wash hue variables go into
   a separate `<style data-event-wash>` inserted **before** any `data-event-theme` element,
   and no redesign styling may use inline `style=` for values an organizer could legitimately
   want to theme (inline styles would beat 31609). Component-scoped Svelte styles are fine —
   they are in the bundle, which precedes injected 31609 CSS in document order.
3. **Monochrome icon set only** (owner directive): every icon is a local SVG component,
   `currentColor`, one stroke weight (1.9) on a 24 px grid, round caps/joins, `aria-hidden`
   by default, no emoji, no icon font, no network fetch. `fill` is allowed only as
   `currentColor` (solid dots) or `currentColor` + `fill-opacity ≤ 0.25` (soft accents) —
   still single-colour. **Calendar and clock imagery is banned** for event/schedule concepts;
   §3.3 gives the replacement per use.
4. **No webfont fetch.** The display face is a system serif stack (§3.2).
5. **Hash router stays** (spec §10.1). New destinations are new `Route` variants in
   `lib/router/routes.ts` + `+page.svelte` registration; the More menu is a route, not a modal
   (rationale in §6.3).
6. **Keep the shipped safe-UX behavior intact:** roster search/filter (`events/roster.ts` +
   `Attendees.svelte`), NIP-51 mutes (`events/mutes.ts` + `stores/mutes.svelte.ts`),
   `ErrorState.svelte`, BottomNav a11y attributes (aria-current, aria-hidden icons, non-colour
   active marker), kind-10050 DM relay publishing, per-route titles/focus/skip-link in
   `+layout.svelte`. Ledger in §13.
7. **U2 (meeting plan) is out of scope.** Matches keeps the ranked-list model; only the
   presentation changes.
8. **Quality gate per phase:** `pnpm --filter @nostrautica/app typecheck` reports 0 errors,
   `pnpm --filter @nostrautica/app test` green, `pnpm --filter @nostrautica/app lint` clean,
   every new i18n key present in BOTH `en` and `sk` catalogs (the `MessageKey` type enforces
   the key set; the sk values must be real Slovak, not English copies).
9. **31608 custom event pages keep working.** EventHome's custom menu/sections rendering
   (P9 work) must survive the Overview restructure unchanged in behavior.

---

## 2. What the redesign is

Five moves, from the approved mockups:

- **Event-scoped shell:** inside `#/e/<naddr>` the bottom nav becomes
  Overview · People · Matches · Updates · More(avatar). Global tools live behind More.
  Compact event header persists on every event subpage. 48 px targets, real icons,
  clear current-tab treatment (U3 + A7).
- **Overview readiness journey:** Joined → Backup secured → Intro submitted → Processing →
  Matches ready, derived (never persisted as a second copy), exactly one primary CTA (U1).
- **Matches confidence treatment:** "Strong match" + route glyph instead of a bare 87 %;
  reasoning promoted to hero; numeric similarity/complementarity/overall behind a
  "Score details" disclosure (design direction).
- **Identity layer:** deterministic initial avatars, monochrome nautical icon set,
  event colour wash + constellation motif in the header, display serif for event titles,
  semantic status pills (shape + colour + text, never colour alone).
- **Organizer ops console:** Admin reordered Operations-first (U4), phased last.

---

## 3. Design language

### 3.1 Token additions to `packages/app/src/lib/styles/app.css`

Add to the theme-independent `:root` block:

```css
:root {
  /* Display face for event titles and key moments only. System stacks; no fetch. */
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino,
                  "Book Antiqua", Georgia, serif;
  /* Event hue pair (degrees). JS overrides these per event via the wash injector
     (§6.5); defaults echo the brand purple so non-event and fallback states match. */
  --event-h1: 256;
  --event-h2: 322;
  /* Bottom-nav geometry (A7) */
  --nav-target: 48px;
}
```

Add to `:root, [data-theme="dark"]`:

```css
  /* Semantic status (A6). Text-grade: must be ≥ 4.5:1 on --bg AND --bg-elev. */
  --ok: #3fb877;
  --warn: #e0a53a;
  --danger: #e5686c;          /* replaces the old :root-level #e5484d in dark */
  --ok-soft: rgba(63, 184, 119, 0.16);
  --warn-soft: rgba(224, 165, 58, 0.16);
  --danger-soft: rgba(229, 104, 108, 0.14);
  /* Decorative constellation/route strokes (always aria-hidden contexts) */
  --route-line: color-mix(in srgb, var(--accent) 60%, transparent);
  /* Raised surface for the sticky nav + menus, above --bg-elev2 */
  --bg-raised: #1d1d27;
  --shadow-raised: 0 -1px 0 var(--border);
  /* Low-contrast event wash, built from the hue pair */
  --event-wash: linear-gradient(160deg,
      hsl(var(--event-h1) 72% 62% / 0.22),
      hsl(var(--event-h2) 65% 58% / 0.12) 55%,
      transparent);
```

Add to `[data-theme="light"]`:

```css
  --ok: #1e7f4f;
  --warn: #8a5c04;
  --danger: #c62b31;
  --ok-soft: rgba(47, 158, 99, 0.14);
  --warn-soft: rgba(207, 138, 26, 0.15);
  --danger-soft: rgba(216, 58, 63, 0.10);
  --route-line: color-mix(in srgb, var(--accent) 55%, transparent);
  --bg-raised: #ffffff;
  --shadow-raised: 0 -1px 0 var(--border), 0 -6px 20px rgba(22, 18, 48, 0.06);
  --event-wash: linear-gradient(160deg,
      hsl(var(--event-h1) 70% 55% / 0.14),
      hsl(var(--event-h2) 62% 55% / 0.08) 60%,
      transparent);
```

Migration notes:

- Today `--ok: #30a46c` and `--danger: #e5484d` live in the theme-independent `:root`.
  **Move them into the per-theme blocks** with the values above and grep every consumer
  (`.warn` card, `.btn.danger`, badges) — behavior must not change except improved contrast.
- **Contrast acceptance (hard):** verify with a checker that in light theme `--ok`, `--warn`,
  `--danger` are each ≥ 4.5:1 against `#fafafc` and `#ffffff`, and in dark against `#0e0e15`
  and `#17171f`. The values above are chosen to pass; if any measures short, darken (light) /
  lighten (dark) the L channel minimally — do not change hue.
- Add reusable classes next to `.badge`:
  `.badge.ok { background: var(--ok-soft); color: var(--ok); }`,
  `.badge.warn { … }`, `.badge.accent { background: var(--accent-soft); color: var(--accent); }`.

### 3.2 Type pairing

- `--font-display` is used ONLY for: the event title in `EventHeader`, the h1 of event-scoped
  pages (Overview implicit via header, "People", "People to meet", "Updates"), and the Home
  hero h1 if desired later. Weight 600, `letter-spacing: 0` (the serif needs no negative
  tracking), `text-wrap: balance`.
- Everything else — controls, body, labels, numbers — stays `--font` (system-ui). Numeric
  score details use `font-variant-numeric: tabular-nums`.
- No `@font-face`, no external `<link>`. Acceptance: the network tab shows zero font requests.

### 3.3 Icon system

**Implementation:** `packages/app/src/lib/components/icons/Icon.svelte` + a typed registry
`packages/app/src/lib/components/icons/paths.ts`:

```ts
// paths.ts — inner SVG markup per icon (24×24 viewBox, stroke handled by Icon.svelte)
export const ICONS = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" fill-opacity="0.25"/>',
  people: '…', constellation: '…', horn: '…', star: '…', plus: '…', chat: '…',
  person: '…', sliders: '…', search: '…', waypoint: '…', horizon: '…', pennant: '…',
  lock: '…', check: '…', chevronDown: '…', chevronLeft: '…', arrowUpRight: '…',
  copy: '…', sun: '…', moon: '…', muted: '…', info: '…', warning: '…', send: '…',
} as const;
export type IconName = keyof typeof ICONS;
```

```svelte
<!-- Icon.svelte -->
<script lang="ts">
  import { ICONS, type IconName } from "./paths.js";
  let { name, size = 24, label }: { name: IconName; size?: number; label?: string } = $props();
</script>
<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden={label ? undefined : "true"} role={label ? "img" : undefined}
     aria-label={label}>{@html ICONS[name]}</svg>
```

(`{@html}` is safe here: the registry is a static local constant, never user input. If lint
objects, individual components per icon are the fallback — same visual spec.)

**Shared spec:** 24 px grid, 1.5 px optical padding to the edge, stroke 1.9, round caps/joins,
`currentColor` only, fills only `currentColor` (small solid dots) or
`currentColor`+`fill-opacity:0.25`. Decorative route/constellation lines always `aria-hidden`.

**Icon-per-use table (final — the calm, nautica-aligned set):**

| Use | Icon name | Glyph sketch (one line) |
|---|---|---|
| Event nav · Overview | `compass` | Compass rose: 9 r circle, NE-pointing needle diamond, quarter-filled at 0.25 opacity (mockup shape, exact paths in the mockup HTML) |
| Event nav · People | `people` | Paired points: head circle + shoulder arc, second smaller figure offset behind (mockup shape) |
| Event nav · Matches | `constellation` | Route of connected points: polyline rising left→right through 4 solid dots, largest dot last (mockup shape) |
| Event nav · Updates | `horn` | Hailing horn: triangular megaphone body + short mouthpiece bracket + one sound stroke (mockup shape) — broadcast, not a bell |
| Event nav · More | — | The user's own `Avatar` (initials, 22 px) — not an icon |
| Global nav · Events | `star` | Four-point star (the brand "✦"): two crossed pointed lozenges — "a star to steer by", replaces 🏠/📅 |
| Global nav · Create | `plus` | Plus: two centered strokes |
| Global nav · Messages | `chat` | Rounded speech bubble with a small tail |
| Global nav · Me | `person` | Single point: head circle + shoulder arc |
| Global nav · Settings | `sliders` | Three horizontal rails with offset knob dots |
| Event date / "when" (replaces 📅 — **banned**) | `horizon` | Horizon star: flat horizon line, small four-point star floating above it — calm "a fixed point to navigate by", never a calendar or clock |
| Event location (replaces 📍) | `waypoint` | Waypoint: teardrop pin outline with a center dot |
| "Starts in / Happening now / Ended" marker | `pennant` | Small triangular flag on a mast stroke — raised pennant = live, no clock face anywhere |
| Pinned posts (replaces 📌) | `pennant` | Same pennant, 16 px inline |
| Members-only (replaces 🔒) | `lock` | Padlock outline, rounded shackle |
| Search | `search` | Magnifier: circle + 45° handle |
| Back (TopBar, replaces "‹") | `chevronLeft` | Single chevron |
| Disclosure ("Score details") | `chevronDown` | Single chevron, rotates 180° when open (no rotation under reduced-motion) |
| External link (replaces "↗") | `arrowUpRight` | Diagonal arrow with corner bracket |
| Theme toggle (replaces ☀/☾) | `sun` / `moon` | Circle + 8 short rays / crescent |
| Copy npub/link | `copy` | Two overlapping rounded rects |
| Done step / success | `check` | Single checkmark stroke |
| Checking/unknown status | `info` | Circle + dot-and-stem i |
| Warning/destructive | `warning` | Rounded triangle + exclamation |
| Muted person | `muted` | Circle with a diagonal slash |
| Send DM | `send` | Paper plane |
| Match confidence | (in `ConfidenceBadge`, §8) | 30×16 mini-SVG: two dots joined by a route — rising curve (strong), gentle arc (good), dashed straight line (worth a hello) |

**Emoji sweep (same phase as the icon set):** remove every emoji from UI chrome —
`BottomNav.svelte` (🏠 ＋ 💬 👤 ⚙), `TopBar.svelte` (☀ ☾ ‹), `EventHome.svelte` (📅 📍 📌 🔒),
`Admin.svelte` (🔒), `Home.svelte` ("＋ Create another"), and the `messages.ts` strings that
embed them ("login.youreIn" 🎉, "app.brand" keeps the ✦ text glyph — it is the brand mark, not
an emoji, and it matches the new `star` icon). Grep acceptance:
`grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' packages/app/src/lib packages/app/src/routes`
returns only deliberate content strings (target: none in chrome).

### 3.4 Avatars

`packages/app/src/lib/identity/avatar.ts` (pure, unit-tested) + `components/Avatar.svelte`:

```ts
export function avatarHues(pubkeyHex: string): [number, number]; // sha256-derived, like media/image.ts hues()
export function avatarGradient(pubkeyHex: string): string;
// `linear-gradient(135deg, hsl(H1 60% 38%), hsl(H2 55% 30%))` — L pinned low so white
// initials pass 4.5:1 at EVERY hue (unit test asserts contrast across 0–359°).
export function initialsFor(name?: string, npub?: string): string;
// 1–2 uppercase grapheme clusters (Intl.Segmenter): "Šimon Koska"→"ŠK", "sats"→"SA",
// no name → first 2 chars after "npub1" prefix, uppercased.
```

`Avatar.svelte` props: `{ pubkey: string; name?: string; picture?: string; size?: number }`.
Renders `picture` in a circle when present; on `onerror` or absence falls back to the gradient
+ initials `<span>`. The image is decorative (`alt=""`); the accessible name always comes from
the surrounding row/card text. Used everywhere a person appears: People rows, Matches cards,
Attendee detail, DM lists, the More nav tab.

---

## 4. Derived data models (all pure cores, all unit-tested)

### 4.1 Readiness — `packages/app/src/lib/events/readiness.svelte.ts` (NEW)

> Naming note: the audit's U1 text says "add to `events/onboarding.ts`", but its own dated
> status corrects this — `onboarding.ts` is the kind-0/kind-3 profile-merge helper and must
> not be touched. Plan step P2.6 names the new module `events/readiness.svelte.ts`; use that.
> Split the pure derivation into `events/readiness.ts` (plain TS, testable without runes) and
> keep the reactive store in `readiness.svelte.ts` — mirror how `roster.ts`/`mutes.ts` pair
> with their `.svelte.ts` stores.

```ts
// readiness.ts — pure
export type ReadinessStepId = "joined" | "backup" | "intro" | "processing" | "matches";
export type ReadinessStepState =
  | "complete" | "action-required" | "in-progress" | "waiting" | "failed" | "checking";

export interface ReadinessInput {
  role: "visitor" | "pending" | "attendee" | "organizer"; // from grant + join-sent marker
  signerMethod?: "local" | "nip07" | "nip46";
  backupAcked: boolean;         // backupNag.done today; P0.2 durable relay ack later (§4.1.1)
  hasIntro?: boolean;           // 31602 self-copy has kind:"intro"; undefined = fetch failed
  processed?: boolean;          // own 31603 directory entry carries ai_profile; undefined = unknown
  matchesAvailable?: boolean;   // fetchMatches returned a 31605 list; undefined = unknown
  matchingEnabled: boolean;     // ctx.config.matching === "on"
  hasCoordinator: boolean;      // !!ctx.config.coordinator
  online: boolean;              // online.isOnline
  latched: Set<ReadinessStepId>; // monotonic per-coordinate memory (see store)
}

export interface ReadinessStep {
  id: ReadinessStepId;
  state: ReadinessStepState;
  labelKey: MessageKey;         // "readiness.step.joined" …
  hintKey?: MessageKey;         // shown for the current step only
}
export interface Readiness {
  steps: ReadinessStep[];       // 3 steps when matching off/no coordinator, else 5
  doneCount: number;
  currentIndex: number;         // first non-complete step; -1 when all complete
  allComplete: boolean;
  primary?: { labelKey: MessageKey; route: Route };   // EXACTLY one, or none when complete
}
export function deriveReadiness(input: ReadinessInput): Readiness;
```

**Derivation rules (the acceptance tests):**

- `joined`: role attendee/organizer → `complete`. role pending → `in-progress`
  ("Waiting for approval"). visitor → `action-required`, primary = Join.
- `backup`: signer non-local → `complete` (key lives in the signer — hint says so).
  Local + `backupAcked` → `complete`, else `action-required`, primary = backup (routes to
  `me`, or renders `BackupCard` inline on Overview — implementer's choice, one place only).
  Never claim complete without the ack.
- `intro`: `hasIntro === true` → `complete`; `false` → `action-required`, primary =
  `{ name: "record", naddr, talk: false }`; `undefined` (self-copy fetch failed / offline) →
  `checking`.
- `processing` (only when `hasCoordinator`): intro complete && `processed === false` →
  `in-progress` ("The coordinator is working on your profile"); `processed === true` →
  `complete`; `undefined` → `checking`. Intro not complete → `waiting`.
- `matches` (only when `hasCoordinator && matchingEnabled`): `matchesAvailable` → `complete`
  (CTA becomes secondary "See your matches"); else `waiting`; `undefined` → `checking`.
- When `matchingEnabled === false` or `!hasCoordinator`: steps are `joined, backup, intro`
  only — never show a step that cannot happen.
- **Monotonic latch:** any step whose id is in `latched` renders `complete` regardless of
  current inputs. The store adds a step to the latch the first time it derives `complete`,
  keyed per event coordinate, in-memory only (a Map in the store — NOT persisted; the model
  itself stays derived). This is what makes offline say "Checking status" without regressing
  a finished step.
- **Exactly one primary CTA:** the first step with `action-required`. `waiting`/`in-progress`/
  `checking` steps never produce a primary. When `allComplete`, the journey collapses to a
  single `.badge.ok` row ("You're all set — matches ready") — no CTA competition.
- Post-approval routing (U1): `Join.svelte`'s approved branch changes from the lone
  "See who's here" button to: primary **"Record your intro"** (when `hasIntro !== true`) that
  routes to record, secondary "Go to event overview" → `{ name: "event", naddr }`; when an
  intro exists, primary is "Go to event overview". The backup card stays.

`ReadinessStore` (`readiness.svelte.ts`): `load(ctx, signer)` gathers inputs
(`isApproved`, `joinSentAt`, `backupNag.done`, `loadSelfCopy` via `deriveBlindingKey`,
own 31603 via `fetchDirectoryEntry`, `fetchMatches`), exposes `$state` readiness + `refresh()`.
Every fetch failure maps to `undefined` inputs, never to a thrown error on the Overview.

**4.1.1 Integration note:** "Backup secured" reads the self-reported
`stores/backup-nag.svelte.ts` ack today. When P0.2 (durable relay backup) lands, swap the
input source to the authenticated backup status — the model and UI don't change, only the
input wiring. Leave a `// TODO(P0.2)` at the wiring site.

### 4.2 Confidence — `packages/app/src/lib/events/confidence.ts` (NEW, pure)

```ts
export type ConfidenceBand = "strong" | "good" | "hello";
export function confidenceBand(score: number): ConfidenceBand;
// score ≥ 0.80 → "strong" · ≥ 0.60 → "good" · else "hello". Clamp NaN/∞ to "hello".
```

Bands map to i18n labels `matches.band.strong` ("Strong match"), `.good` ("Good match"),
`.hello` ("Worth a hello") and to the three route glyphs (§3.3 table, last row). The raw
`score/similarity/complementarity` from the `Match` schema render only inside the disclosure.

### 4.3 Constellation — `packages/app/src/lib/events/constellation.ts` (NEW, pure)

```ts
export interface Constellation { points: { x: number; y: number; r: number }[]; path: string }
export function eventConstellation(pubkeyHex: string): Constellation;
// 4–6 points seeded from sha256(pubkey) laid across a 300×120 viewBox with margins
// (x spread 20–280, y 25–95, r 2–3.2), plus the polyline `path` joining them in x order.
// Deterministic: same event always draws the same constellation. Unit-test determinism
// and bounds.
```

Rendered by `EventHeader` as an `aria-hidden` SVG: dots `fill="currentColor"`, line
`stroke="var(--route-line)"`, whole SVG `color: var(--accent)`, opacity ~0.5. Static — no
animation (nothing to disable under reduced-motion).

### 4.4 Event shell state — `packages/app/src/lib/stores/event-shell.svelte.ts` (NEW)

The nav and persistent header need event context + role without every page re-plumbing it:

```ts
class EventShell {
  naddr = $state<string | undefined>();
  ctx = $state<EventContext | undefined>();
  role = $state<"visitor" | "pending" | "attendee" | "organizer">("visitor");
  loading = $state(false);
  // derived tab gating:
  get showPeople(): boolean   { return role is attendee/organizer }
  get showMatches(): boolean  { return showPeople && !!ctx?.config.coordinator
                                       && ctx.config.matching === "on" }
  get isOrganizer(): boolean;
  async sync(naddr: string | undefined): Promise<void>;
  // called from a +layout $effect with eventNaddr(router.route), token-guarded
  // exactly like theme-injector.ts (stale responses dropped). Uses cachedEventContext
  // first so tab gating almost never flashes. Reads isApproved() + loadEventKeys()
  // (IndexedDB, cheap) + joinSentAt() for role. Re-syncs on session pubkey change.
}
export const eventShell = new EventShell();
```

Pages keep their own `onMount` loading exactly as today (they need richer data anyway);
the shell store is additive and read-only for nav/header. `receiveGrants` stays a page
concern — the shell only *reads* stored state, so it can never race a grant write.

---

## 5. Component inventory

### 5.1 NEW components

| File (under `packages/app/src/lib/`) | Responsibility | Props / state | Builds on |
|---|---|---|---|
| `components/icons/paths.ts` | Typed monochrome icon registry (§3.3) | — | replaces emoji everywhere |
| `components/icons/Icon.svelte` | Render one registry icon | `name, size?, label?` | — |
| `identity/avatar.ts` (+ `.test.ts`) | Deterministic hues/gradient/initials | pure fns | pattern from `media/image.ts` `hues()` |
| `components/Avatar.svelte` | Person avatar w/ image fallback → initials | `pubkey, name?, picture?, size?` | — |
| `events/constellation.ts` (+ test) | Deterministic header constellation | pure fn | — |
| `components/EventNav.svelte` | Event-scoped bottom nav (5 slots) | reads `eventShell`, `router` | **replicates BottomNav's shipped a11y pattern**: `aria-current="page"`, `aria-hidden` icons, `::before` non-colour marker, safe-area padding |
| `stores/event-shell.svelte.ts` | Shared event ctx/role for shell (§4.4) | — | `event-context.ts`, `attendee.ts`, `keystore.ts` |
| `pages/EventMore.svelte` | The More menu as a route (§6.3) | `naddr` | `Avatar`, `LanguagePicker`, session |
| `events/readiness.ts` + `events/readiness.svelte.ts` (+ test) | Readiness model + store (§4.1) | — | `backup-nag`, `submit.ts` self-copy, `attendee.ts` |
| `components/ReadinessJourney.svelte` | Ordered stepper + single primary CTA | `readiness: Readiness`, `naddr` | semantic tokens; `<ol>` + `aria-current="step"` |
| `events/confidence.ts` (+ test) | Score → band (§4.2) | pure fn | — |
| `components/ConfidenceBadge.svelte` | Route glyph + band label | `score: number; size?: "sm" \| "md"` | `confidence.ts` |
| `components/PersonCard.svelte` | Shared person row (avatar, name, one-liner, trailing slot) | `pubkey, name, line?, picture?, onOpen`, snippet `trailing` | extracted from the **existing** Attendees row markup — keep its translation-aware bio logic at the call site |
| `pages/admin/*.svelte` (phase 7) | Extracted Admin sections | per §9 | existing Admin handlers move, don't change |

### 5.2 CHANGED components

| File | Change | Keeps (do not regress) |
|---|---|---|
| `styles/app.css` | Token additions §3.1; move `--ok`/`--danger` per-theme; `.badge.ok/.warn/.accent`; nav target var | contrast comments, reduced-motion block, `.btn`/`.card`/skip-link |
| `components/BottomNav.svelte` | Becomes the **global-only** variant (layout stops rendering it on event routes). Emoji → `Icon` (star/plus/chat/person/sliders); `min-height: var(--nav-target)`; labels ≥ 12px | `aria-current`, `aria-hidden` icons, `::before` active marker, `nav.primary` label, safe-area padding — all shipped A2/A6/A7 work |
| `routes/+layout.svelte` | Shell switch (§6.1): EventNav + compact EventHeader on event routes, BottomNav elsewhere; register `eventMore` in nothing (routes.ts does) | boot order, A2 title/focus/announce effects, offline banner, skip link, `syncEventTheme` effect |
| `lib/router/routes.ts` | Add `{ name: "eventMore"; naddr }` ↔ `#/e/<naddr>/more`; `title.eventMore` key; include in `eventNaddr()` | hash semantics, all existing routes |
| `lib/router/router.svelte.ts` | `parentOf(eventMore) → event` | back-stack behavior |
| `routes/+page.svelte` | Register `EventMore` | `{#key}` blocks |
| `components/TopBar.svelte` | ☀/☾ → `sun`/`moon` icons, "‹" → `chevronLeft`; on event routes hide the brand link (the event header carries context) — back + theme remain | back logic, aria-labels |
| `stores/theme.svelte.ts` | `apply()` also updates `<meta name="theme-color">` to the effective `--bg` (`#0e0e15` dark / `#fafafc` light); re-apply on system-preference change listener | storage key, API |
| `events/theme-injector.ts` | Also owns the wash layer (§6.5): `<style data-event-wash>` with the event hue vars, inserted **before** `data-event-theme`, same lifecycle/token guard | 31609 injection contract untouched |
| `components/EventHeader.svelte` | v2: wash + constellation + `--font-display` title + meta row (horizon/waypoint icons) + status badge; compact variant for subpages; organizer banner image, when present, renders as the card background under the wash (constellation only when no banner) | `link` tap-through to event home, `compact` prop name |
| `pages/EventHome.svelte` | → Overview (§7): readiness card first, "Latest" update section, meta block via new header; **31608 menu/sections rendering preserved verbatim**; install hint stays | grants/approval flow, recent-events recording, custom page logic (P9) |
| `pages/Join.svelte` | Approved branch: primary "Record your intro" / "Go to event overview" (§4.1) | join/backup flow, secret handling |
| `pages/Matches.svelte` | Confidence treatment (§8) | `ErrorState` usage, mutes filtering, ranked order, fetch logic |
| `pages/Attendees.svelte` | → People (§10 phase 6): `PersonCard` + `Avatar`, display-serif h1 "People" | **entire U8 search/filter/sort block, U10 mute filtering, ErrorState + retry — untouched logic** |
| `pages/Attendee.svelte` | `Avatar` at top; icon sweep | mute/report/notes actions (U10), transcript affordances |
| `pages/Dm.svelte` / `DmChat.svelte` | `Avatar` in peer rows/header; `send` icon | 10050 relay publishing, outbox behavior |
| `pages/Admin.svelte` | Phase 7 ops-console reorder + extraction (§9) | every handler, P9 page/theme editors, pending-count strip logic |
| `lib/i18n/messages.ts` | Keys per phase (§11), en + sk | key typing discipline |

---

## 6. Event-scoped shell mechanics

### 6.1 Layout decision — global vs event context

In `+layout.svelte`:

```svelte
const evNaddr = $derived(eventNaddr(router.route));   // already imported for theme sync
$effect(() => { if (booted) void eventShell.sync(evNaddr); });
```

Render:

- `evNaddr === undefined` → `<BottomNav />` (global variant) — unchanged behavior on
  home/login/create/me/settings/dm routes.
- `evNaddr` set → `<EventNav naddr={evNaddr} />` and, for **subpages only** (route name ≠
  `event` and ≠ `record`), a compact `<EventHeader ctx={eventShell.ctx} compact link />`
  rendered by the layout directly under the TopBar. `EventHome` keeps rendering its own
  full hero header (it owns the loading lifecycle); `Record` stays chrome-light (focused
  flow — nav visible, no header, no `aria-current` tab). Pages that currently render their
  own compact header (`Matches.svelte`, `Attendees.svelte`, `Posts.svelte`, `Post.svelte`,
  `Attendee.svelte`, `Join.svelte` if present) **drop it** — one header, owned by the layout.
- The A2 effects (title/focus/announce) and the offline banner are above this switch and
  must not move.

### 6.2 EventNav tabs, gating, targets

Five slots (mockup): **Overview · People · Matches · Updates · More**.

- Overview → `{ name: "event", naddr }`; active for `event` and `join`.
- People → `{ name: "attendees", naddr }`; active for `attendees` + `attendee`.
  **Shown only when `eventShell.showPeople`** (attendee/organizer — the roster is
  member-encrypted; a tab that always dead-ends at "join first" is noise). Visitors/pending
  get Overview · Updates · More.
- Matches → `{ name: "matches", naddr }`; shown only when `eventShell.showMatches`
  (approved ∧ coordinator set ∧ `matching === "on"`), per the audit's role/config gating.
- Updates → `{ name: "posts", naddr }`; active for `posts` + `post`. Always shown (public).
- More → `{ name: "eventMore", naddr }`; the tab renders the user's `Avatar` (22 px) when
  logged in, the `person` icon when not; active for `eventMore`.

A11y/geometry (A7, carried over from the shipped BottomNav work): `<nav aria-label={t("nav.eventPrimary")}>`,
buttons `min-height: var(--nav-target)` and full-width flex ≥ 48 px wide at 320 px,
`aria-current="page"` on the active tab, the `::before` top-bar marker (forced-colors safe),
labels 12 px/600 that wrap nowhere (test the Slovak strings), icons `aria-hidden`,
`padding-bottom: calc(… + env(safe-area-inset-bottom))`, background `var(--bg-raised)` +
`--shadow-raised`, backdrop-blur as today.

Deep links and Back: unchanged — tabs are plain `router.go` calls; `parentOf` already returns
the event home for subroutes; add `eventMore → event`.

### 6.3 The More menu — a route, not a sheet

`#/e/<naddr>/more` → `pages/EventMore.svelte`. Rationale: the hash router + A2 focus/title
machinery + Android back button all work for free on a route; a modal sheet would need a
focus trap, Esc/back interception, and an aria-modal audit for zero product gain. (Flagged as
a deliberate deviation from the mockup's implied popover — see §14.)

Content (audit IA "More: messages, identity handoff, settings, event privacy details"):

1. Identity row: `Avatar` + display name/npub → `{ name: "me" }`.
2. **Messages** → `{ name: "dm" }` (only when logged in, mirroring BottomNav today).
3. **Manage event** → `{ name: "admin", naddr }` — only when `eventShell.isOrganizer`
   (Admin itself keeps its own role check; UI gating is not security).
4. **All events** → `{ name: "home" }`; **Create an event** → `{ name: "create" }`.
5. **Settings** → `{ name: "settings" }` (theme + language live there; keep the TopBar
   quick-toggle too).
6. **Event privacy** section: the event's matching/AI disclosure copy (reuse the existing
   join-screen provider-disclosure strings; link to Join for the full text).

Each row: icon + label, `.btn`-sized targets (44 px+), plain buttons in a `.card` list.

### 6.4 Persistent compact header

`EventHeader compact` on subpages: single row — event icon (24 px, existing `defaultEventIcon`
fallback), serif title (16 px, ellipsized), status badge (Approved/Pending/Live via
`.badge.ok/.accent`), tap-through to Overview (existing `link` behavior, keep the
`role="link"` + button semantics). It reads `eventShell.ctx`; while `ctx` is undefined
(first paint on a cold deep link) render a quiet skeleton row, never layout-shift the page h1.

### 6.5 Event colour wash under the §7.4 theme layer

- `avatarHues`-style derivation but seeded from the **event pubkey** (`parseCoordinate(ctx.coordinate).pubkey`)
  → `[h1, h2]` hue pair. Reuse one shared hue helper (export from `identity/avatar.ts`).
- `theme-injector.ts` gains `syncEventWash(naddr)` folded into the existing `syncEventTheme`
  lifecycle: while an event route is active, maintain
  `<style data-event-wash>:root { --event-h1: <h1>; --event-h2: <h2>; }</style>` inserted
  via `document.head.insertBefore(washEl, themeEl ?? null)` — **always before** any
  `data-event-theme` element; removed together with it on leaving the event; same
  request-token invalidation. The wash needs only `ctx` (no extra fetch), so it applies
  synchronously from `cachedEventContext` when available.
- Consumers use `var(--event-wash)` (the gradient composed in app.css from the hue vars):
  `EventHeader` background layer, and optionally a 120 px top-of-page veil on Overview.
  Text never sits on the wash without the normal surface underneath (the mockup's `.inner`
  pattern — wash is `position:absolute; inset:0` behind a normal-token content layer).
- Because 31609 CSS is a later stylesheet, an organizer can override `--event-h1/--event-h2`
  or `--event-wash` outright — the layering contract from §1.2 holds by construction.
  Acceptance test: an event with a 31609 theme setting `--event-wash: none` shows no wash.

---

## 7. Overview (EventHome restructure)

Order, per the mockup and the audit IA ("compact event metadata/status, latest update, U1
readiness, exactly one primary next action"):

1. **Hero `EventHeader`** (full variant): wash + constellation + serif title + meta line
   (dates via `horizon` icon, location via `waypoint`, separator "·") + status badge.
   Approval-mode + matching badges move into the header meta (delete the old badge row).
2. **Readiness card** (`ReadinessJourney`) — approved/pending/visitor states all render here;
   for visitors the journey is the Join CTA (step 1 action-required). "See who's here"
   secondary button below the primary. The old hand-rolled CTA card
   (`EventHome.svelte:209-262`) is **replaced** by this card — same routes, one source of
   truth for "what's next".
3. **Custom menu (31608)** — unchanged rendering, restyled buttons (lock icon instead of 🔒).
4. **"Latest" update** — the newest item from the existing posts fetch under an uppercase
   kicker label, then the 31608 sections / default feed exactly as today. "All updates" →
   `posts` route (the Updates tab).
5. Install hint card — unchanged logic.

`fmt()` date rendering: keep `toLocaleString` for now — the full metadata block (end time,
timezone, ICS, map) is audit step **P3.7 and stays out of this redesign** (don't half-build
it here; the header shows start date + location as today, just with icons).

---

## 8. Matches (confidence treatment)

`pages/Matches.svelte` restructure (mockup §03):

- h1 becomes localized "People to meet" (`matches.title` value change) in `--font-display`;
  subtitle uses the existing ranked note, extended when the viewer's intro is in
  ("your intro is in, so these are live" — key `matches.live`).
- **Card layout per match** (first ~3 cards full, rest compact rows — implementer may render
  all full-size if simpler; the mockup shows both):
  1. Row: `Avatar` (42 px) + name + one-line descriptor (directory `about`, truncated).
  2. `ConfidenceBadge` — route glyph + "Strong/Good match"/"Worth a hello" from
     `confidenceBand(m.score)`. Accent colour for strong only; good/hello use text/dim —
     band is also encoded in the glyph shape (A6: never colour alone).
  3. **Reasoning as hero**: `m.reasoning` at full body size (no longer squeezed under a
     percentage).
  4. Actions row: "Message" → `dmPeer`, "Open profile" → `attendee` detail (Want-to-meet
     lives on the detail page — unchanged, U2 stays out).
  5. `<details class="score">` "Score details": Similarity / Complementarity / Overall as
     `tabular-nums` decimals (keep 0–1 decimals, not percentages — they're model values;
     the summary row uses `chevronDown`, native details/summary keyboard behavior).
- Delete the bare `87%` badge and the always-visible similarity/complementarity badges.
- **Empty/unavailable states:** thrown errors keep `ErrorState` (already wired). The
  "no coordinator" and "no matches yet" states stay quiet cards (NOT `ErrorState` — it is
  `role="alert"` and would announce a non-error; see §14 item 2) but get upgraded copy:
  "no matches yet" links the cause — if the viewer has no intro, say so and offer the Record
  CTA (read `readiness` store: it already knows).
- Mutes filtering (`visibleMatches`) — untouched.

---

## 9. Organizer ops-console (Admin, phased last)

Scope per U4/audit organizer IA, **presentation-only** — every handler, protocol call, and the
P9 page/menu/theme editors keep their exact behavior.

- Reorder `pages/Admin.svelte` top-to-bottom: **Operations** (status strip: pending count /
  attendee count / intro count / match recompute + liveness `sinceLabel`; then the
  join-requests section with bulk approve; then reprocess/failures) → **Communicate**
  (updates composer, share link, invites) → **People** (approved list, revoke) →
  **Event setup** (coordinator attach, co-organizers, appearance = 31608/31609 editors) →
  **Health** (liveness detail). Urgent-above-healthy: the requests block renders before
  anything else whenever `pending.length > 0`.
- Extract child components under `lib/pages/admin/` (`Operations.svelte`,
  `Communicate.svelte`, `People.svelte`, `Setup.svelte`) passing state + callbacks down —
  a mechanical move to keep Admin.svelte reviewable (~930 lines today). No logic edits.
- Sticky in-page section nav (buttons that scroll to headings, like the existing
  `scrollToRequests`) instead of a desktop two-column layout: the app shell is
  `--maxw: 640px` globally; widening Admin is a layout change beyond this redesign
  (flagged §14). Keyboard-accessible section headings (`tabindex="-1"` + scroll targets).
- Icon sweep + semantic badges (`.badge.ok/.warn`) for liveness/queue states — "stale/unknown
  is never green": unknown liveness renders `.badge.warn` "Checking status".
- Acceptance (from P3.6): with a pending request present, it is visible without scrolling
  past setup/invite QR at 412×915.

---

## 10. Build sequence

Sizes use the audit convention: S ≤ ½ day, M = 1–2 days, L = 3+ days. Each phase ships alone;
run the §12 gates per phase. i18n = add to BOTH `en` and `sk`.

### Phase 1 — Identity primitives (M)
**Files:** `styles/app.css` (§3.1 tokens + badge classes + `--ok/--danger` per-theme move),
`components/icons/paths.ts`, `components/icons/Icon.svelte`, `identity/avatar.ts` (+ test),
`components/Avatar.svelte`, `components/BottomNav.svelte` (icons + 48 px, still global
5 tabs), `components/TopBar.svelte` (icons), `stores/theme.svelte.ts` (theme-color meta sync),
emoji sweep call sites (`EventHome`, `Admin`, `Home`, `messages.ts` strings), `Avatar`
adoption in `Attendees`/`Matches`/`Attendee`/`Dm` rows (replacing the bare `<img>`/empty-circle
pattern).
**i18n:** none required beyond string emoji removal (e.g. `login.youreIn`).
**Acceptance:** zero emoji in chrome (grep §3.3); every list row shows an avatar (photo or
initials — no empty grey circles); avatar contrast test green across all hues; theme toggle
updates `<meta name="theme-color">`; nav targets ≥ 48 px at 320 px; typecheck/tests/lint green.

### Phase 2 — EventHeader + colour wash (S–M)
**Files:** `events/constellation.ts` (+ test), shared hue helper export, `events/theme-injector.ts`
(wash layer §6.5), `components/EventHeader.svelte` v2 (full + compact variants, serif title,
wash, constellation, meta icons, status badge), `styles/app.css` (only if a shared
`.event-status` class is needed).
**i18n:** `event.status.approved`, `event.status.pending`, `event.status.visitor` (badge labels).
**Acceptance:** wash hues deterministic per event and identical across subpages; a 31609
theme overriding `--event-wash` wins (manual fixture test); header text ≥ 4.5:1 on the washed
surface in both themes; banner-image events still render legibly; constellation is
`aria-hidden` and static.

### Phase 3 — Event-scoped nav shell (L)
**Files:** `lib/router/routes.ts` (+`eventMore`, title key, `eventNaddr`), `router.svelte.ts`
(`parentOf`), `routes/+page.svelte`, `stores/event-shell.svelte.ts`,
`components/EventNav.svelte`, `pages/EventMore.svelte`, `routes/+layout.svelte` (shell switch
+ layout-owned compact header §6.1), remove per-page compact `EventHeader` from `Matches`,
`Attendees`, `Attendee`, `Posts`, `Post`.
**i18n:** `nav.eventPrimary`, `nav.overview`, `nav.people`, `nav.matches` (reuse), `nav.updates`,
`nav.more`, `title.eventMore`, `more.identity`, `more.manageEvent`, `more.allEvents`,
`more.createEvent`, `more.eventPrivacy`, `more.messages`/`more.settings` (reuse nav.* where
identical).
**Acceptance:** audit U3 test list — visitor/pending/attendee/organizer tab sets, matching-off
hides Matches, direct deep links land with correct tab + header, Back preserved, 320 px no
wrap with sk labels, keyboard traversal + `aria-current`, global routes still show the global
bar. A2 title/announce fires for `eventMore`.

### Phase 4 — Overview + readiness journey (M)
**Files:** `events/readiness.ts` + `events/readiness.svelte.ts` (+ `readiness.test.ts`),
`components/ReadinessJourney.svelte`, `pages/EventHome.svelte` (§7 restructure),
`pages/Join.svelte` (approved branch §4.1).
**i18n:** `readiness.title` ("Getting you ready"), `readiness.progress` ("{done} of {total}"),
`readiness.step.joined/backup/intro/processing/matches`, `readiness.hint.pending/backup/intro/
processing/checking/signerKey`, `readiness.allSet`, `readiness.cta.join/backup/record/matches`,
`join.recordIntro`, `join.goToOverview`, `event.latest`.
**Acceptance:** U1 test list — new attendee, restored attendee, no-coordinator (3-step),
matching-off (3-step), offline mid-journey shows "Checking status" and never regresses a
latched step, exactly one primary CTA in every state, approved-Join screen leads with Record;
31608 custom sections still render; unit tests cover every derivation rule in §4.1.

### Phase 5 — Matches confidence treatment (M)
**Files:** `events/confidence.ts` (+ test), `components/ConfidenceBadge.svelte`,
`pages/Matches.svelte` (§8), `components/PersonCard.svelte` if extracted here (else phase 6).
**i18n:** `matches.title` (value → "People to meet"), `matches.band.strong/good/hello`,
`matches.scoreDetails`, `matches.dim.similarity/complementarity/overall`, `matches.live`,
`matches.none.noIntro`, `matches.message`, `matches.openProfile`.
**Acceptance:** no visible bare percentage outside the disclosure; band label + distinct glyph
shape per band (A6); details/summary keyboard + screen-reader clean; mutes still filter;
ranked order unchanged; empty/no-coordinator states quiet, error states via `ErrorState`.

### Phase 6 — People polish (S–M)
**Files:** `components/PersonCard.svelte` (if not yet), `pages/Attendees.svelte` (rows →
PersonCard, serif h1 "People", chip styling to match mockup — **zero logic changes** to
search/sort/filter/mutes), `pages/Attendee.svelte` (Avatar header).
**i18n:** `attendees.title` value → "People" (en+sk).
**Acceptance:** all existing roster/mutes unit tests untouched and green; search + chips +
sort behave byte-identically; a 200-row roster scrolls without jank (PersonCard is plain
markup, no per-row stores).

### Phase 7 — Organizer ops-console (L, independently schedulable)
**Files:** `pages/Admin.svelte` + new `lib/pages/admin/{Operations,Communicate,People,Setup}.svelte`.
**i18n:** `admin.section.operations/communicate/people/setup/health`, `admin.checkingStatus`.
**Acceptance:** §9 — pending requests visible without scrolling; every existing Admin action
verified by walking the flows (approve, bulk approve, revoke, reprocess, invites, updates,
page editor, theme editor incl. live preview); unknown status never renders as ok/green.

---

## 11. i18n rules

- All keys land in `lib/i18n/messages.ts` in the phase that introduces them, en + sk together
  (the `MessageKey` type is derived from `en`, and sk must mirror the key set — typecheck
  enforces presence; the implementer writes real Slovak).
- Nav labels must be checked at 320 px in sk (`Prehľad`, `Ľudia`, `Stretnutia`, `Novinky`,
  `Viac` are the expected translations — verify with the catalog's existing terminology).
- Never concatenate; use `{token}` interpolation (`readiness.progress`: "{done} of {total}" /
  "{done} z {total}").

## 12. Accessibility acceptance + visual-regression matrix

**Per-feature a11y acceptance (blockers):**

- EventNav/BottomNav: 48×48 px targets at 320 px and 200 % zoom; `aria-current="page"`;
  active marker visible in `forced-colors: active` (the `::before` bar uses `currentColor` —
  verify it survives forced colors, add `forced-color-adjust` only if needed); labels ≥ 12 px.
- ReadinessJourney: `<ol>` with `aria-current="step"` on the current step; state conveyed in
  text ("Done", "Current step", hint), not knob colour alone; the single primary CTA is a
  real button reachable directly after the list.
- ConfidenceBadge: band conveyed by label text + glyph shape; glyph `aria-hidden`; details
  disclosure is native `<details>`.
- Avatar: `alt=""` images, name always in adjacent text.
- Icons: `aria-hidden` unless a `label` is passed; interactive icon-only buttons always get
  `aria-label` (theme toggle, back).
- Route changes (incl. `eventMore`): existing A2 machinery announces once, title localized,
  focus to `<main>` — layout refactor must not break the shipped effects.
- Live regions: readiness state changes on the open page announce via the existing polite
  region pattern (reuse the `role="status"` count pattern from Attendees).
- Reduced motion: no new animation anywhere except the chevron rotation — gate it; the
  constellation and wash are static.

**Visual-regression matrix** — run per phase on the affected screens; this repo has no
screenshot harness (tests are vitest units), so this is a documented manual pass in dev
(`pnpm --filter @nostrautica/app dev`) plus unit tests for every pure module. If the
implementer wants automation, a Playwright screenshot job is welcome but NOT required by this
plan; do not block phases on building one.

| Axis | Cases |
|---|---|
| Theme | light, dark, system-switch mid-session (theme-color meta follows) |
| Event palette | hue extremes: seed events whose derived `--event-h1` ≈ 60 (yellow-green) and ≈ 200 (cyan) — wash legibility + header contrast both themes |
| Avatars | photo, photo 404 (fallback fires), no name (npub initials), 2-grapheme diacritics (ŠK), CJK name |
| Viewports | 320, 412, 768, 1280 px — no horizontal scroll (`scrollWidth ≤ clientWidth`), nav never wraps |
| Zoom | 200 % text zoom at 412 px — nav, chips, readiness stepper intact |
| Forced colors | `forced-colors: active` — nav marker, step knobs, badges distinguishable |
| Reduced motion | `prefers-reduced-motion: reduce` — no transitions (existing global rule covers new components since they use tokens/classes; verify chevron) |
| Keyboard | full traversal of EventNav → page → More; visible focus everywhere (`:focus-visible` token ring) |
| Offline | airplane-mode after first load: icons render (inline SVG — nothing to fetch), readiness shows "Checking status", cached roster/matches browse |
| States | visitor / pending / attendee / organizer × matching on/off × coordinator set/unset (nav gating + readiness step count) |

## 13. Reuse vs supersede ledger (vs the concurrent safe-UX agent's shipped work)

| Shipped work | Redesign decision |
|---|---|
| Roster search/filter — `events/roster.ts`, search input + chips + sort in `Attendees.svelte` (U8) | **REUSE, untouched logic.** Phase 6 only re-skins the rows (PersonCard/Avatar) and h1. `roster.ts` and its tests are off-limits. |
| NIP-51 mutes — `events/mutes.ts`, `stores/mutes.svelte.ts` (U10) | **REUSE, untouched.** `visibleMatches`/roster filtering and the Attendee-detail mute action carry through every restyled surface. |
| `components/ErrorState.svelte` (Q3) | **REUSE** for all thrown/network errors on redesigned pages (already wired in Matches/Attendees — keep the `onRetry` pattern). **Deliberately NOT used** for empty/unavailable states (it's `role="alert"`); see §14.2. |
| BottomNav a11y — aria-current, aria-hidden icons, `::before` non-colour marker, `nav.primary` label (A2/A6/A7 partial) | **SUPERSEDE the tab set inside events** (EventNav replaces it there), **REUSE the a11y pattern verbatim** in both EventNav and the retained global BottomNav. The attributes/marker must exist in both variants — copy, don't re-derive. |
| kind-10050 DM relay publishing | **UNTOUCHED.** DM pages only gain Avatar/icons. |
| Per-route titles/focus/skip-link in `+layout.svelte` + `routeTitleKey` (A2) | **REUSE and extend**: the layout shell switch is added around the existing effects; `eventMore` gets a title key. Do not reorder the boot/effect blocks. |
| P9 event customization — 31608 page/menu rendering in EventHome, 31609 theme injector, Admin editors | **REUSE and layer under**: Overview keeps section rendering; the wash extends `theme-injector.ts` without altering the 31609 contract; Admin editors move sections but keep behavior. |
| `stores/backup-nag.svelte.ts` self-reported backup ack | **REUSE as the "Backup secured" input** until P0.2's durable relay backup lands (§4.1.1). |
| U6 Home split / P2.7, U7 metadata block / P3.7, P2.5 SaveStatus, A3 history router | **NOT in this redesign** — separate audit plan steps; don't half-implement them here. Home gets only the phase-1 icon/avatar sweep. |

## 14. Judgment calls made (flag to owner only if they object)

1. **More is a route (`#/e/<naddr>/more`), not a popover sheet** — hash-router/back-button/A2
   integration for free (§6.3).
2. **Empty and "unavailable" states do not use `ErrorState`** — it renders `role="alert"`;
   announcing "no matches yet" as an alert is wrong a11y. Errors → ErrorState; empties →
   quiet cards with cause-aware copy (§8).
3. **People/Matches tabs hidden for visitors/pending** rather than shown-but-dead-ended,
   per the audit's "show only destinations available to the role/configuration".
4. **Organizer banner images** (when uploaded) render under the wash and suppress the
   constellation; wash+constellation is the no-banner default (mockup showed only the
   no-banner case).
5. **Admin desktop two-column deferred** — the global `--maxw: 640px` shell makes it a layout
   project; phase 7 ships the reorder + section nav instead (§9).
6. **`matches.title` page heading becomes "People to meet"** while the nav tab stays
   "Matches" (both appear in the mockup).
7. **Confidence bands** fixed at ≥ 0.80 strong / ≥ 0.60 good / else hello — tunable constants
   in `confidence.ts`, one place.
