# Marmot Group Chat — current behavior

The only shipped per-event group-chat backend is **Marmot** (MLS-over-Nostr),
enabled by a `chat = marmot` tag on the 31600 event config. This page describes
what the implementation does today; the deep design docs are linked below.

- **Normative wire spec:** [`PROTOCOL-NIP.md`](PROTOCOL-NIP.md) §10 (chat device
  keys, the kind-21607 attestation, proof of possession, per-account device cap).
- **Multi-device design + rationale:** [`MULTIDEVICE-CHAT.md`](MULTIDEVICE-CHAT.md).
- **Historical phased plan:** [`archive/MARMOT-GROUP-CHAT.md`](archive/MARMOT-GROUP-CHAT.md)
  (the original §-numbered build plan that code comments still cite by section).

## Per-device identity model

Chat identity is **per device**, not per account. Every browser/device mints its
own chat keypair and attests it to the account via a gift-wrapped kind-21607
attestation; each device is then an ordinary, independent MLS group member. This
is GPT56-AUDIT §13.10's "Option B" — distinct credentials are just distinct
members, so the same npub can participate from mobile and desktop at once. Synced
history across devices is a non-goal: MLS state is per-leaf and each device reads
from its own join epoch forward.

- **Local-nsec accounts** can sign the MLS identity proof directly, so the account
  key may itself act as a chat device key.
- **NIP-46 / NIP-07 accounts** cannot raw-sign the proof, so they mint an
  app-generated chat device key and bind it with a 21607 attestation whose
  `op:"add"` carries a proof of possession signed by the device key (§10.2). The
  per-account active-device count is capped (§10.1).

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
