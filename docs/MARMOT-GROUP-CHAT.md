# Marmot Group Chat: current behavior

The only shipped per-event group-chat backend is **Marmot** (MLS-over-Nostr),
enabled by a `chat = marmot` tag on the 31600 event config. This page describes
what the implementation does today; the deep design docs are linked below.

- **Normative wire spec:** [`PROTOCOL-NIP.md`](PROTOCOL-NIP.md) §10 (chat device
  keys, the kind-21607 attestation, proof of possession, per-account device cap).
- **Multi-device design + rationale:** [`MULTIDEVICE-CHAT.md`](MULTIDEVICE-CHAT.md).
- **Historical phased plan:** the original §-numbered build plan (that code comments
  still cite by section) has been retired from the published docs.

## Per-device identity model

Chat identity is **per device**, not per account. Every browser/device mints its
own chat keypair and attests it to the account via a gift-wrapped kind-21607
attestation; each device is then an ordinary, independent MLS group member. This
is GPT56-AUDIT §13.10's "Option B": distinct credentials are just distinct
members, so the same npub can participate from mobile and desktop at once. Synced
history across devices is a non-goal: MLS state is per-leaf and each device reads
from its own join epoch forward.

**Only attested device keys are chat members**, for *every* account type. The raw
account pubkey is never itself an implicit chat identity; it participates only through
a device key it has attested.

- **All account types** (local-nsec, NIP-46, NIP-07) mint a fresh app-generated
  chat device key per device and bind it with a 21607 attestation whose `op:"add"`
  carries a proof of possession signed by the device key (§10.2). The per-account
  active-device count is capped (§10.1).
- A local-nsec account is no exception: it too mints and attests a distinct per-device
  chat key rather than reusing the account key as the member. (This began as a
  necessity: the legacy identity proof needed raw BIP-340 signing, which NIP-46/NIP-07
  signers cannot do. The current proof is an ordinary kind-450 event, but every MLS
  commit and leaf update still needs a signer that answers without a remote round
  trip, so the app-held device key stays.)

## What the coordinator does (admin bot)

The coordinator runs a headless Marmot admin bot
(`packages/coordinator/src/chat/`):

- Creates one MLS group per chat-enabled event and keeps its routing relays and
  admin set current.
- Authenticates 21607 attestations, binds account ⇄ chat device key, and adds
  each approved attendee's attested devices from their kind-30443 key packages.
- Removes a member's leaves (real MLS Remove → forward secrecy) on revoke or
  attendee withdrawal, also while chat is turned off: turning chat off freezes the
  group (no adds or Welcomes) but keeps every leaf, and turning it back on
  re-activates the same group.
- Publishes the active `nostr_group_id` on the 31604 roster, the authoritative
  event→group binding clients verify before trusting a group.
- Promotes each approved **organizer**'s chat devices to MLS co-admins, so the
  group stays administrable if the coordinator's own state is lost (see the
  operator runbook's recovery section).
- Keeps the group avatar (`marmot.group.avatar-url.v1`, 0x8007) equal to the event's
  icon: the `picture` of the event identity's (E_id) kind-0, not the banner. It is
  applied when chat comes up and re-applied when a newer E_id kind-0 changes the
  picture (a kind-0 subscription for chat-enabled events). A removed icon clears the
  avatar, an icon URL that is not a valid https URL is skipped with a log line, and
  nothing is committed when the normalized URL already matches (`chat/avatar.ts`).

## What clients do

The app enrolls the current device's chat key at approval time, discovers the
group via the roster's `nostr_group_id`, and reads live kind-445 traffic forward
from its own join epoch. A device that loses its chat key mints a new one and
re-attests; the old leaf is removed on revoke.

## Also chatting from White Noise (external Marmot clients)

An approved attendee can link the identity of an external Marmot client, typically a
White Noise npub, to their account for one event. The coordinator then adds that key
to the event's group like any other device. The normative flow is NIP §10.5; in short:

- **UI:** "Also chat from White Noise or another Marmot client" sits under the chat's **Chat devices** list
  (`WhiteNoiseLinkCard.svelte`, logic in `chat/external-link.ts`). It takes an npub,
  nprofile or hex key, or fills in the account npub with one tap.
- **Same key as the account:** a 21607 `op:"link"` is sealed by that key, which proves
  possession, so the coordinator binds and invites it at once.
- **A different key:** the coordinator invites it into a throwaway two-member group
  ("Nostrautica: confirm White Noise link") and posts one message with an 8-character
  code. The user accepts the invite in White Noise and types the code into Nostrautica
  (`op:"link_confirm"`). The coordinator stores only a hash of the code; it expires
  after 30 minutes and dies after 5 wrong tries. On a match the key is bound, added
  through the normal `syncMember` path, and the confirmation group is torn down.
- **Afterwards** the key is a device: listed in the roster's `chat_keys` with
  `external: true` (the device list badges it), counted against the device cap,
  removable with the ordinary revoke. It is never promoted to MLS co-admin, even for
  an organizer. It reads from its join epoch forward, like every device.
- **Feedback** arrives as 21606 notices on stage `chat_link` (refusals as `poison` with
  a category, progress as `cleared`), kept apart from the `chat_attestation` setup
  banner.
- **Delivery to the external client:** its key package is found via its NIP-65 relays
  (`key-package-discovery.ts`), and its kind-10050 inbox via the default and chat
  interop relays and then its NIP-65 relays (`network.ts`), so the Welcome lands where
  White Noise reads.
- **Key-package reuse:** the confirmation group consumes one of the external client's
  key packages. The event-group add prefers a rotated one, holds off up to 90 s when
  only the spent one is visible, then uses it (correct for last-resort key packages).

Verified live against the White Noise CLI (MDK 0.11.0, the version the shipped apps
use, and MDK HEAD) with the opt-in `e2e/tests/chat/wn-interop.spec.ts`: both link
paths, messages both ways, avatar commits followed by White Noise, and revoke.

## MDK 0.15+ members (Android app, current White Noise)

The Android app runs MDK through MarmotKit (0.16.0, `android/tools/marmotkit/fetch.sh`).
Since MDK 0.15 every MDK KeyPackage and leaf advertises
`marmot.group.account-devices.v1` (**0x800d**), a component with no data. marmot-ts
accepts such a member: the kind-30443 `app_components` tag lists 0x800d exactly as the
leaf does, which is what the #94 tag check compares, and an extra advertised component
is not a requirement. The coordinator's rooms never require 0x800d, and MDK leaves an
existing group without it unchanged. A room that **required** it would be refused by
marmot-ts ("unsupported required component"), so the app never calls MDK's
`enableAccountDevices`, `createGroup` or `startDirectConversation`. MDK also rotates
each KeyPackage weekly and after a Welcome uses it; the coordinator keeps such a member
("fresh 30443 … but no re-enrolment attestation") as for any rotation.

MDK 0.15's automatic rejoin of an `Unrecoverable` copy cannot be switched off. It asks
an admin over the account inbox with a kind-1059 wrap around an MDK-private kind 1159.
The coordinator's rumor-kind allowlist and the web app's Welcome-only invite reader drop
it. An organizer's Android device (MDK, an MLS co-admin) may answer with one Remove+Add
of that same device; the device still holds a leaf afterwards, so the coordinator
records no deliberate removal and re-adds nothing.



Both the app and the coordinator run `@internet-privacy/marmot-ts`, vendored pre-built
in `packages/vendor/marmot-ts` (with its ts-mls fork bundled inside) from
`jooray/marmot-ts` branch `nostrautica-vendor-master-8040bfa`, which is unreleased
upstream master `8040bfa` (v0.9.0 + KeyPackage publish acks and Welcome recovery) plus two
fixes upstream does not have yet (#94 KeyPackage tag checks, and `connectAll` retrying a
group whose connect failed). `packages/vendor/README.md` has the pin, the
carried patches and the one-command re-vendor (`node scripts/vendor-marmot.mjs`).

This generation speaks the **current Marmot profile**. Every KeyPackage and leaf carries
`marmot.member.account-identity-proof.v2` (component **0x8009**): a kind-450 event over
the leaf's MLS signature key, signed by the member's own Nostr key through the
client's ordinary `signEvent`. White Noise / MDK 0.11+ accept only this profile. The
previously vendored marmot-ts 0.6.0 wrote the legacy 0xF2F1 proof, so its groups and
KeyPackages are incompatible in both directions.

**The upgrade is a flag day** (owner decision: old rooms and their history are
discarded, not migrated). Each side retires what it cannot run:

- **Coordinator** (`chat/retire.ts`, at startup before any group loads): every stored
  group that loads under a legacy profile (`unsupported`), and every room row with no
  stored state at all (`missing`), is purged from `marmot_kv` and its `marmot_groups`
  row dropped. The ordinary `ensureChat` then creates a fresh group, which
  republishes the roster with the new `nostr_group_id`, and backfill plus the 30443
  watcher re-add each attested device as soon as it publishes a current KeyPackage.
  This publishes nothing for the retired group, needs no schema change, and does
  nothing on later starts. A group whose state exists but **does not load**
  (`unreadable`) is **kept**, not retired. A failed load says nothing about the
  profile, and retiring a live room on one failed load at a deploy (2026-10-23)
  pulled every member into a new group and destroyed the evidence. Its error is
  logged and the next access retries the load. The web app likewise keeps a local
  group that fails to load and retries it. Only a positively `unsupported` profile
  is destroyed there.
- **Pre-upgrade KeyPackages** (from a tab still running the old build, or an outdated
  White Noise) are recognised up front and skipped quietly: marked consumed, not
  reported to the owner as a refused device. The device fixes it itself.
- **App** (`MarmotChat.retireLegacyState`, on every chat client creation): local
  groups outside the current profile are destroyed together with their history and
  event binding, and KeyPackages that marmot flags `nonCurrent` are purged. The next
  `ensurePublished` publishes a current 30443 in the same `d` slot and re-attests, and
  the device joins the new room through the normal Welcome path.

**KeyPackage slot.** Since marmot-ts 0.7.0 the `d` of a kind-30443 must be 32 random
bytes as lowercase hex, persisted per install. Builds before that used `web-<16 hex>`;
such an install mints a new slot once, publishes under it, and then deletes the old
address with a NIP-09 `a` deletion. Spent KeyPackages from the old slot are dropped
locally; an unused one keeps its private key, because an in-flight Welcome may be
encrypted to it.

**Encrypted media.** marmot-ts now creates every group with
`marmot.group.encrypted-media.v2` (0x800b), listing MDK's default Blossom servers, as
a required component — exactly what MDK does. Nostrautica does not send media in chat,
but we keep the component: White Noise members need it to send and see images in the
room, and dropping it (`encryptedMedia: false`) would also make the group refuse
invitees whose KeyPackages advertise it differently from MDK's. Nostrautica clients
simply ignore media references they cannot render.

## Rejoining a device that fell out of the group

A device can be a listed, active chat device of an approved attendee (it appears
in the roster's `chat_keys`, so the app's "Chat devices" card shows it, badged as
this device), while holding no group state at all: the coordinator's Welcome was
lost, the local MLS state was cleared, or the group was recreated under a new
routing id. Chat then looks joined but every send fails.

Re-advertising the same key package does not fix that, because it is a no-op at
three points: marmot returns the existing *unused* local key package (so the same
addressable kind-30443 is republished under the same `d`, same event id),
the coordinator dedupes that event id for 30 days (`marmot_consumed_kps`), and it
skips anyone who still holds a leaf.

So the app offers **Rejoin this chat**. Every Rejoin is a visible kick for the
device, so since 0.17 it is offered **only on positive evidence that the device is
out of the room** (the roster no longer lists it, or its own state shows it was
removed). A failed send, a slow "setting up", an unread roster, or a membership
check that could not be answered does not count. Clients also attest only on a
positive "not a member", never on "unknown". In the web app it takes two steps.
Confirming runs an unforced rejoin, which sends nothing unless the eviction is
positive. If the eviction was not positive, a separate **force** option sits
behind a second, explicit confirmation. Android follows the same rule
(`ChatPolicy.offerRejoin`), and after a removal it first waits 90 s for the
coordinator's re-add Welcome.

The web Rejoin revokes this device's chat key (dropping the coordinator-held leaf),
rotates the key package (a new event id under the same slot), and re-attests,
which the coordinator handles as an ordinary enrolment: Add commit + Welcome.
When an `add` attestation instead finds the device still holding a leaf, the
coordinator re-enrols it in **one commit** carrying the Remove and the Add
(`MarmotClientMls.reenrol`), never as a Remove followed by a separate Add, subject
to the guards in [Re-enrolment guards](#re-enrolment-guards). The revoke and the add are two separate
gift wraps that can arrive in either order, so the coordinator keeps the newest
accepted `created_at` per device for each op and ignores an add or revoke strictly
older than the other; the app sends the add in a later second than the revoke.
The device key, its label, its roster
entry and its device-cap slot are all reused, unlike clearing site data, which
mints a new identity and burns another slot.

The coordinator reconciles from its side too: whenever it deliberately syncs a
member (approval, a fresh attestation, the startup backfill) it re-adds an
attested device that holds no leaf even if that device's key package was already
consumed. The passive kind-30443 watcher keeps the plain consumed-id check, so a
relay replaying old key packages cannot drive repeated Add commits.

History from before the new Add stays unreadable in every case: MLS is
forward-secret from each leaf's own join epoch.

### The add decision table

Every add path funnels through one routine (`tryAddKeyPackage`), and what it does
is a function of three things it can observe: whether this event already spent
this key package's event id, whether the coordinator holds a leaf for the author,
and which trigger is asking. Writing that out as a table is worth the space: five
consecutive production incidents in this area were each a single wrong cell, and
each fix reasoned about the trigger it had in hand rather than the whole column.

| Leaf? | Key package | Passive 30443 watcher | Deliberate sync: this device attested here | Deliberate sync: backfill / sibling device |
|---|---|---|---|---|
| no | fresh | Add | Add | Add |
| no | consumed | skip (dedupe) | **re-Add** (repairs a lost Welcome) | **re-Add** |
| yes | fresh | skip | **re-enrol**: one Remove + Add commit, if the guards below allow | **skip**, see below |
| yes | consumed | skip | skip | skip |

The one cell that needs the trigger, not just the state, is *leaf + fresh key
package*. A fresh key package is not evidence that the device left this group,
because **one kind-30443 slot serves every event the device belongs to**: rotating
it to rejoin event A makes it look brand new to event B too. Only the device's own
kind-21607 attestation naming this event says anything about its membership *here*, so that is the only thing allowed to drop a live leaf. The backfill runs on every
coordinator restart (and therefore every deploy), and a sibling device's
attestation sweeps in every device of the account, so treating either as a
re-enrolment signal evicts members who were never in trouble. That is not a
recoverable hiccup: an offline client loses every message sent before its next
open, permanently.

Since 0.18 the attestation also says which of those it is (`intent` on the 21607
`op:"add"`, PROTOCOL-NIP §10.2), so the *leaf + fresh* cell for "this device attested
here" splits three ways:

| `intent` | Coordinator holds a leaf for the device |
|---|---|
| `enrol` | keep the leaf, never remove it; binding and label are still updated |
| `rejoin` | Remove + Add in one commit, if the key package is fresh for this request (at most 120 s older than the attestation) and the warrant is under an hour old; the leaf-activity guard is **skipped** |
| absent (pre-0.18 client) | legacy inference: the same freshness and warrant checks, plus the leaf-activity guard (`REENROL_ACTIVITY_WINDOW_MS`, 5 minutes) |

Clients send `intent` at all only when the event's coordinator lists
`"attest-intent"` in its kind-31611 `features.chat`; to any other coordinator, or
while its announcement is not known yet, they send the bare 0.17 add. Where they
do send it, they send `rejoin` only on positive evidence that their own leaf is gone (they
hold this event's room without it: the web app at once, Android once its 90 s wait
for the coordinator's re-add has passed) or from the Rejoin action the user pressed.
Every other add (first enrolment, a device that was never added, key-package
rotation, a rename riding an attestation, a refusal retry) sends `enrol`. The durable `chat_sync_member` retry stores the intent with
the warrant: an `enrol` retry carries no warrant at all, and a `rejoin` retry whose
warrant has expired falls back to a plain sync that cannot evict. A retry row
written before 0.18 has no intent and keeps the legacy inference.

The corresponding client-side rule: every check that means *"am I in the room?"*
must ask about the **leaf**, not about whether a group id resolves. A removed
member still holds the group state locally: that corpse is what makes "chat looks
joined but every send fails" possible in the first place.

### Re-enrolment guards

The protocol carries no explicit "rejoin" intent on a 21607 `add`: the coordinator
infers it. Adding an `intent` field would be a wire change, and the protocol is
frozen. Pre-0.17 Android installs (which do not auto-update) still attest on
weaker evidence. So even the one cell that may drop a live leaf is gated, in
`tryAddKeyPackage`:

- **Warrant.** Only a sync driven by this device's own attestation for this event
  carries it, and only for the device's newest key package. It expires after an
  hour (`REENROL_WARRANT_MS`), so a durable retry cannot evict long after the
  request.
- **Key-package lead.** The key package may be at most 120 s older than the
  attestation (`REENROL_KP_LEAD_SEC`). One rotated minutes earlier for another
  event is not this request.
- **Activity.** A leaf that sent a message or made a commit in the last
  **5 minutes** (`REENROL_ACTIVITY_WINDOW_MS`) is kept, and the attestation is
  treated as a refresh. The check is time-only on purpose. In a quiet room the
  epoch can stand still for days, and an epoch condition would strand a device
  that really lost its state. The guard is a transitional measure for pre-0.17
  clients. It only protects members who just posted, because a reader is never
  "active". Activity comes from the coordinator's own ingest, is stored in
  `marmot_kv` (`leaf-activity`), and is dated by the event's `created_at`,
  clamped to now. A backfill or relay replay therefore cannot make an old
  message look fresh. **If the activity record cannot be read, the leaf is kept**
  and the attestation goes to the durable `chat_sync_member` retry with its
  warrant. An unreadable record is not "no activity".

When all of this passes, the Remove and the Add go out as one commit, with the
Welcome. Member Adds, like the setup commits, run through the daemon-wide chat
commit queue, so restoring several events at once does not publish their commits
in one burst.

**Lost Adds.** An Add can be acknowledged and then lose fork resolution to a
co-admin's commit for the same epoch. The device then holds a Welcome for a dead
branch. The coordinator remembers every device it added in the last 10 minutes
(`marmot_kv`, `recent-invites`, so this survives a restart). After any ingest
that moves the epoch, it re-queues the sync of such a device that no longer
holds a leaf. A device that this same ingest **removed on purpose** is forgotten
instead of re-added: a co-admin's Remove, or its own self_remove that the
coordinator auto-committed. A removal done only at the MLS layer is still undone
by the next restart's roster backfill. The roster (approved attendee, active
chat key) is the authority, and the way to take a device out for good is to
revoke it there.

## Commits whose publication is uncertain

A relay can store a commit and lose its OK. The kind-445 publish waits 15 s for
an OK, and a timeout or transport error counts as **uncertain**, not as a
refusal. marmot-ts then keeps the commit's exact bytes in a pending-publication
record, holds inbound traffic, and accepts no new commit for the group until a
relay acknowledges those bytes. They are re-sent before every ingest, at load,
and every minute. Rolling such a commit back used to fork the room: members had
already fetched epoch N+1, and the coordinator's next commit was a second
N→N+1.

If the record itself will not restore (a partial write, a format change), the
group does not load. The coordinator drops the record only when it can name the
commit's event id and relays, **every one of those relays answered** (a real
EOSE, not nostr-tools' synthetic one), and none of them has it. In every other
case the group stays `unreadable` and the log says `KEPT BLOCKED`, with the event
id, epoch and relays: the commit is on a relay, a relay did not answer, or the
record no longer names its commit. Dropping a commit that members may hold would
fork the room again, so resolving it is left to an operator. It is re-checked at
every start.
