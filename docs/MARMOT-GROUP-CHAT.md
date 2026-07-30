# Marmot Group Chat — current behavior

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
is GPT56-AUDIT §13.10's "Option B" — distinct credentials are just distinct
members, so the same npub can participate from mobile and desktop at once. Synced
history across devices is a non-goal: MLS state is per-leaf and each device reads
from its own join epoch forward.

**Only attested device keys are chat members** — for *every* account type. The raw
account pubkey is never itself an implicit chat identity; it participates only through
a device key it has attested.

- **All account types** (local-nsec, NIP-46, NIP-07) mint a fresh app-generated
  chat device key per device and bind it with a 21607 attestation whose `op:"add"`
  carries a proof of possession signed by the device key (§10.2). The per-account
  active-device count is capped (§10.1).
- A local-nsec account is no exception: it too mints and attests a distinct per-device
  chat key rather than reusing the account key as the member. (The MLS identity proof
  requires raw BIP-340 signing, which the app-held device key always provides;
  NIP-46/NIP-07 signers cannot raw-sign it at all.)

## What the coordinator does (admin bot)

The coordinator runs a headless Marmot admin bot
(`packages/coordinator/src/chat/`):

- Creates one MLS group per chat-enabled event and keeps its routing relays and
  admin set current.
- Authenticates 21607 attestations, binds account ⇄ chat device key, and adds
  each approved attendee's attested devices from their kind-30443 key packages.
- Removes a member's leaves (real MLS Remove → forward secrecy) on revoke or
  attendee withdrawal.
- Publishes the active `nostr_group_id` on the 31604 roster — the authoritative
  event→group binding clients verify before trusting a group.
- Promotes each approved **organizer**'s chat devices to MLS co-admins, so the
  group stays administrable if the coordinator's own state is lost (see the
  operator runbook's recovery section).

## What clients do

The app enrolls the current device's chat key at approval time, discovers the
group via the roster's `nostr_group_id`, and reads live kind-445 traffic forward
from its own join epoch. A device that loses its chat key mints a new one and
re-attests; the old leaf is removed on revoke.

## Rejoining a device that fell out of the group

A device can be a listed, active chat device of an approved attendee — it appears
in the roster's `chat_keys`, so the app's "Chat devices" card shows it, badged as
this device — while holding no group state at all: the coordinator's Welcome was
lost, the local MLS state was cleared, or the group was recreated under a new
routing id. Chat then looks joined but every send fails.

Re-advertising the same key package does not fix that, because it is a no-op at
three points: marmot returns the existing *unused* local key package (so the same
addressable kind-30443 is republished under the same `d` — same event id),
the coordinator dedupes that event id for 30 days (`marmot_consumed_kps`), and it
skips anyone who still holds a leaf.

So the app offers **Rejoin this chat** — next to a failed send, and in the
"setting up" state once it has been slow for a while. It revokes this device's
chat key (dropping the coordinator-held leaf), rotates the key package (a new
event id under the same slot), and re-attests, which the coordinator handles as an
ordinary enrolment: Add commit + Welcome. The device key, its label, its roster
entry and its device-cap slot are all reused — unlike clearing site data, which
mints a new identity and burns another slot.

The coordinator reconciles from its side too: whenever it deliberately syncs a
member (approval, a fresh attestation, the startup backfill) it re-adds an
attested device that holds no leaf even if that device's key package was already
consumed. The passive kind-30443 watcher keeps the plain consumed-id check, so a
relay replaying old key packages cannot drive repeated Add commits.

History from before the new Add stays unreadable in every case — MLS is
forward-secret from each leaf's own join epoch.

### The add decision table

Every add path funnels through one routine (`tryAddKeyPackage`), and what it does
is a function of three things it can observe — whether this event already spent
this key package's event id, whether the coordinator holds a leaf for the author,
and which trigger is asking. Writing that out as a table is worth the space: five
consecutive production incidents in this area were each a single wrong cell, and
each fix reasoned about the trigger it had in hand rather than the whole column.

| Leaf? | Key package | Passive 30443 watcher | Deliberate sync — this device attested here | Deliberate sync — backfill / sibling device |
|---|---|---|---|---|
| no | fresh | Add | Add | Add |
| no | consumed | skip (dedupe) | **re-Add** (repairs a lost Welcome) | **re-Add** |
| yes | fresh | skip | **remove leaf, then Add** (re-enrolment) | **skip** — see below |
| yes | consumed | skip | skip | skip |

The one cell that needs the trigger, not just the state, is *leaf + fresh key
package*. A fresh key package is not evidence that the device left this group,
because **one kind-30443 slot serves every event the device belongs to**: rotating
it to rejoin event A makes it look brand new to event B too. Only the device's own
kind-21607 attestation naming this event says anything about its membership *here*
— so that is the only thing allowed to drop a live leaf. The backfill runs on every
coordinator restart (and therefore every deploy), and a sibling device's
attestation sweeps in every device of the account, so treating either as a
re-enrolment signal evicts members who were never in trouble. That is not a
recoverable hiccup: an offline client loses every message sent before its next
open, permanently.

The corresponding client-side rule: every check that means *"am I in the room?"*
must ask about the **leaf**, not about whether a group id resolves. A removed
member still holds the group state locally — that corpse is what makes "chat looks
joined but every send fails" possible in the first place.
