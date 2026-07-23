# Coordinator discovery + billing-aware attach — plan (2026-07-17)

Status: **partially implemented design.** Announcement and discovery are shipped.
Billing is advisory only: the current coordinator evaluates it at install time and
logs the result, but does not enforce payment or reliably emit a billing state.
Native payment remains deferred; organizers keep the paste-an-npub fallback.

- **Protocol**: `KIND_COORDINATOR_ANNOUNCE = 31611` + `coordinatorAnnounceSchema`
  / `coordinatorPricingSchema` / `coordinatorBillingSchema`; the 21606 status
  gained an optional `billing` block (poison fields relaxed to optional).
- **Coordinator**: publishes its 31611 on boot (`[coordinator]` config, default
  `announce=true`); `[pricing]` + `free_organizers` config; pure
   `buildAnnounceContent` / `evaluateBilling` / `isFreeOrganizer` (tested). Free
   by default; current evaluation is logging only.
- **App**: `fetchCoordinators()` + an Admin picker (cards with features, privacy
  disclosure, pricing label, Attach) with the paste-npub box kept as a fallback;
  a billing banner in the coordinator-status area that appends the event `naddr`
  to the checkout URL (`checkoutUrlForEvent`).

Remaining (step 5): actually wire the coordinator to EMIT a `payment_required`
status when a paid event crosses its free tier, and native ecash/Lightning
behind the `checkout_url`. The pieces below describe the full target.

## Goal

Today an organizer attaches an AI coordinator by pasting its `npub` in Admin
(`attachCoordinator` → republish 31600 with the `coordinator` tag + gift-wrap a
21603 Coordinator Grant). Two gaps:

1. **Discovery** — you have to know the npub. Coordinators should *announce*
   themselves on Nostr (like Routstr nodes do) so an organizer can **pick one
   from a list** (and still paste an npub if they want).
2. **Billing awareness** — AI matchmaking costs scale with attendee count, so a
   coordinator may want to charge. We are **not** building payment now, but the
   protocol should carry a clean "payment required → here's a checkout link"
   signal so we can slot payment in later without a redesign.

## Part 1 — Coordinator Announcement (kind 31611)

A new **public, replaceable** addressable event, signed by the coordinator's
identity key. Authenticity = the pubkey (self-published; see Trust below).

- `kind`: **31611** (next free in the 31600 block, after 31610 Talk).
- `d`: `"nostrautica:coordinator"` (one announce per identity; latest wins).
- `content` (JSON, zod-validated in `packages/protocol`):

```jsonc
{
  "v": 1,
  "name": "Cypherpunk Coordinator",
  "about": "AI matchmaking for freedom-tech events.",
  "picture": "https://…",                 // optional logo
  "operator": "npub1… or contact string",  // who runs it
  "relays": ["wss://relay.primal.net", …], // where it listens + publishes
  "features": { "matching": true, "talks": true, "chat": ["marmot"] },
  // Per-role privacy disclosure — reuses the §16.2/§16.4 language so organizers
  // see, up front, which roles leave the TEE boundary.
  "privacy": { "match": "non-private", "summary": "private", "embed": "private",
               "stt": "private", "translate": "private" },
  "terms_url": "https://…",                // optional ToS/privacy link
  "pricing": {                             // OPTIONAL — see Part 3
    "model": "free",                       // free | per_user | per_event | negotiated | external
    "free_up_to_users": 20,                // optional soft/hard free tier
    "summary": "Up to 20 attendees free; larger events by quote.",
    "checkout_url": "https://…",           // where to pay / get a quote (optional)
    "currency": "sats"                     // optional; often omitted (negotiated)
  }
}
```

Notes:
- **Pricing is optional and need not include exact amounts.** The user's intent:
  the announce should let the app *know how* billing works and where to send the
  organizer, but the amount can be negotiated off-band. A free coordinator sets
  `pricing.model = "free"` (or omits `pricing` entirely).
- The **community free-for-this-npub** case is deliberately *not* in the public
  announce (it would leak an allowlist). It's a private coordinator config knob
   (`free_organizers = ["<E_id hex pubkey>"]`) evaluated at attach time — see Part 3.

## Part 2 — Discovery UI

`fetchCoordinators()` in the app: `fetchEvents({ kinds: [31611] })` over the
default + event relays, dedupe latest-per-pubkey, parse + validate, drop
malformed. Returns a `CoordinatorAnnounce[]`.

Admin → "AI coordinator" section becomes:

- A **list of discovered coordinators**, each a card: logo, name, about,
  feature chips (matching / talks / chat), the privacy disclosure, a one-line
  pricing summary ("Free" / "Free up to 20, then by quote"), and an **Attach**
  button.
- The existing **"Paste npub"** input kept below, as the advanced/fallback path
  (unchanged behaviour). So: *don't have to paste, but can.*
- An optional **"known coordinators"** badge: the app ships a small curated set
  (maintainer follow-set / hardcoded defaults incl. the current free one) so a
  fresh organizer sees a trustworthy default at the top; everything else is
  clearly "community / unverified".

**Attach is unchanged** under the hood — pick from the list just fills the same
`attachCoordinator(pubkey)` call.

## Part 3 — Billing-aware attach (design; not built)

Pricing depends on attendee count, which isn't known at attach time. So billing
is a **stage in the handshake**, surfaced through the *existing* 21606
Coordinator Status channel — not a blocking gate at attach.

Flow:

1. Organizer attaches (as today: 31600 + 21603 grant). The 21603 seal author is
   the event identity **`E_id`**, not the organizer's personal pubkey. The current
   implementation therefore evaluates `free_organizers` as an `E_id` allowlist;
   the name is legacy. A personal-organizer billing principal is future protocol
   work and needs an authenticated event-to-principal binding without weakening
   21603 authentication.
2. The coordinator evaluates eligibility and replies via **21606 Coordinator
   Status** (gift-wrapped → E_id, already fetched by the Admin status widget)
   with an added optional `billing` block:

```jsonc
"billing": {
  "state": "ok" | "payment_required" | "grace",
  "reason": "Event exceeds the 20-attendee free tier",  // human message
  "checkout_url": "https://…",     // link the organizer opens (payment is external for now)
  "due": 5000, "currency": "sats", // optional; may be omitted if negotiated
  "grace_until": 1789999999        // optional; matching keeps running until then
}
```

3. Admin surfaces it in the coordinator-status widget:
   - `ok` → nothing special (attached & active).
   - `payment_required` → a banner: *"Payment required — [Open checkout]"* plus
     the reason. Matching for **new** attendees pauses (existing matches stay);
      the coordinator resumes on payment. **Design target only:** current runtime
      does not enforce this pause.
   - `grace` → "active, payment due by <date>" — soft nudge, no interruption.

4. **Payment itself is out of scope now** — it's just a link. Later options:
   - Cashu/ecash (the coordinator already has a `CashuPayment` provider for its
     *own* AI spend — the organizer→coordinator direction can reuse it), or
   - Lightning invoice / external checkout.
   The `checkout_url` is the seam; swapping in native ecash later doesn't touch
   the announce or the status schema.

### When the free tier is evaluated

Cleanest is **usage-triggered**: the coordinator runs free until the roster
crosses `free_up_to_users`, then emits `payment_required` (with a checkout link)
and stops matching *new* joiners until paid. This needs no up-front size
declaration and matches "up to 20 users free". An organizer allowlisted in
`free_organizers` always gets `state: "ok"`.

## Part 4 — The current (free) coordinator

- Publishes a 31611 announce with `pricing.model = "free"`; always replies
  `billing.state = "ok"` (or omits billing). **Zero behaviour change.**
- Appears in the discovery list as "Free".
- Paste-an-npub still works for anyone not announcing.

## Trust & safety

- Announcements are self-published — anyone can claim to be a coordinator.
  Discovery lists all; the app marks non-curated ones "community / unverified"
  and keeps the maintainer default on top.
- Attaching hands the coordinator `E_inbox` + the ECK (read access to event
  content) — already the threat model (`docs/THREAT-MODEL.md`). The attach UI
  must keep warning that a coordinator can read event content; picking from a
  list doesn't lower that bar.

## Build order (incremental, each shippable alone)

1. **Protocol**: `coordinatorAnnounceSchema` + `KIND_COORDINATOR_ANNOUNCE = 31611`;
   extend `coordinatorStatusContentSchema` with the optional `billing` block.
2. **Coordinator**: publish/refresh its 31611 on boot + config change; add
   `[pricing]`/`free_organizers` config (default free). No payment logic — just
   emit `billing.state` in the status it already sends.
3. **App discovery**: `fetchCoordinators()` + the Admin coordinator picker
   (list + keep paste box). Attach unchanged.
4. **App billing surface**: render `billing` in the coordinator-status widget
   (banner + checkout link). Still no payment handling.
5. **(Later)** native ecash/Lightning payment behind the `checkout_url` seam.

Steps 1–4 are pure plumbing/UX; the free coordinator behaves identically
throughout. Payment is deferred to step 5 without any format change.
