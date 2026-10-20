# Nostrautica: Threat Model

Finalized from SPECIFICATION.md §14 (spec is normative). This summarizes what the
system protects, what it deliberately leaks, and who must be trusted.

## Protected

- **Submission contents pre-approval.** Join requests + profile submissions are
  gift-wrapped to `E_inbox`; only `E_inbox` holders (organizer + attached
  coordinator) can read them.
- **Event content from non-attendees.** Intro videos, talks, directory entries,
  roster, and match matrix are encrypted under the Event Content Key (ECK), which
  only approved attendees receive (via a `21602` grant).
- **Match reasoning from everyone but the pair and the coordinator** (default
  `match_visibility:pair`). Each attendee's match list (`31605`) is NIP-44-encrypted
  coordinator→recipient, so on the relays a pair's score/reasoning is readable only by
  its two members, not other attendees, not the organizer, not the public. The
  coordinator that *computes* the reasoning necessarily knows it (see "Trusted
  parties"); "visible only to the pair" describes on-relay readership, not concealment
  from the coordinator.
- **User-private data** (favorites, want-to-meet, met, notes), NIP-44
  self-encrypted `30078`, unreadable by everyone, including the coordinator.
- **Event impersonation.** Only `E_id` signs the public event/config/invite lists.
  The coordinator never holds `E_id`.
- **Invite forgery.** Published invites are `sha256(invite-pubkey)` (hash-hidden,
  so observers can't enumerate or front-run codes); the join proof is a Schnorr
  signature by the invite key **bound to the attendee's pubkey**, so an
  intercepted proof can't be reused by anyone else.
- **Media confidentiality on Blossom.** Servers see only AES-256-GCM ciphertext
  and blob sizes/hashes; the decryption key travels only inside encrypted payloads.

## Leaks (accepted & documented)

- **Attendee counts.** The number of directory entries per coordinator pubkey is
  observable → approximate attendee counts.
- **Blob-hash linkage across events** when an attendee reuses an intro without the
  "fresh copy" option: the identical ciphertext hash links their presence across
  events. Mitigation offered in-UI: "fresh copy" re-keys the blob to a new hash.
- **Timing correlation on relays**: relays see event timing/sizes/counts.
- **`E_inbox` p-tags on inbound wraps** mark that *someone* submitted (wrap authors
  are one-time keys, so not *who*).
- **Email backup of nsec** traverses email infrastructure, a user-chosen
  convenience trade-off (spec §5.2), stated plainly in the UI; the key rides the
  URL fragment (never sent to a server) but email itself is not confidential.
- **Event CSS is trusted-organizer UI control, not a secret-safe boundary.** It can
  spoof in-event UI and emit allowed image/network beacons. It is kept away from
  secrets by a guard, not by being safe: every surface that shows one (admin
  invite nsecs/QR, key backup, chat device handoff) removes the event stylesheet
  synchronously while it is on screen (spec §7.4, NIP §13). A secret-bearing
  surface that forgets to enter the guard would be exposed to the theme again.
  `font-src 'self'` separately shuts the remote-font text exfiltration channel.
- **Third-party talk embeds disclose the viewer to the host.** A talk submitted as
  an external URL renders as a YouTube embed (spec §7, `media/external.ts`), and
  the CSP admits `frame-src https://www.youtube-nocookie.com` for exactly that.
  Watching such a talk therefore reveals the viewer's IP and user agent to Google.
  Mitigated but not removed: the no-cookie origin, a per-source referrer policy,
  and an explicit pre-load gate so the frame is never created until the attendee
  chooses to play. An attendee who does not press play discloses nothing.
- **Profile pictures are fetched from wherever they are hosted.** Kind-0 `picture`
  and event banner URLs are rendered as ordinary images, so whoever hosts them sees
  each viewer's IP and user agent. This is inherent to displaying other people's
  Nostr profiles.

## Trusted parties

- **Coordinator**: reads all event-encrypted content (it must, to transcribe
  videos) and, because it computes matches, knows all pairwise match reasoning. It is
  organizer-chosen infrastructure and is surfaced as such in the UI ("operated by
  `<npub>`"). It **cannot** impersonate the event or alter the public
  event/config/invites. **Attendee-derived data is mostly plaintext at rest in the
  coordinator's SQLite** (profiles, AI profiles, transcripts, corrections, pair
  reasoning, talk data): only key material (`E_inbox` nsec, ECKs), Cashu proofs, and
  selected MLS/pipeline values are NIP-44-encrypted under the coordinator identity.
  File mode `0600` is access control, **not** encryption: a read-only database or
  unencrypted-backup disclosure reveals attendee bios, transcripts, inferred
  interests, and pairwise reasoning without the coordinator identity key. Operators
  must protect the database file and encrypt backups at rest accordingly.
- **A detached coordinator keeps what it learned only until the event's retention
  deadline** (audit SB-16). A detach deletes the coordinator's custody of the event
  (the `E_inbox` key and every ECK), so it cannot read anything published after
  that, and it drops the event's queued, running and parked (`waiting`) jobs. The
  attendee-derived data it already holds (profiles, AI profiles, transcripts, pair
  reasoning, talks, summaries) is kept until the deadline retention would have
  applied had the event stayed installed: the event's end time plus the `retention`
  days of its last 31600 this coordinator saw. Then the hourly sweep runs the same
  reference-counted local purge it runs for an installed event. If that deadline has
  already passed, the data goes at the next sweep, within the hour. If the event has
  none (no `retention` tag, or no end date, as for every 31612 community), it goes
  7 days after the detach, so a mistaken detach can still be undone. A re-attach to
  the same coordinator before the deadline cancels the purge. Two limits: the
  purge is local only (with the ECKs gone, the old coordinator can no longer address
  its blinded relay records to send NIP-09 deletions), and backups taken before the
  purge still hold the data. An organizer replacing a coordinator should treat the
  old one as holding everything it processed until that deadline (or for a week). See
  COORDINATOR-OPERATOR-GUIDE.md §9.
- **LLM / STT provider**: sees plaintext transcripts and summaries. Mitigations:
  v1 prefers Venice private/TEE-tier models (`require_private`); v2 uses
  operator-chosen Routstr nodes.
- **Relays / Blossom**: see ciphertext + metadata only.

## Marmot MLS chat

- **Coordinator authority.** The coordinator is an MLS group member/admin and can
  read group chat. It adds/removes members and therefore needs durable MLS state.
- **Chat identity is per device: attested devices only.** Every browser/device
  mints its own chat device keypair on first chat use, for *every* account type
  (local key, NIP-07, NIP-46 alike), and attests it to the account with an
  account-sealed `21607` carrying a proof of possession signed by the device key.
  Only attested device keys are group members; the raw account pubkey is **never**
  itself an implicit chat identity, a local-key account attests its own per-device
  key like any other. The attestation proves the account authorized this device key
  *and* (via the possession proof) that the attester controls it.
- **No backup, no restore.** There is no relay backup of a chat device key and no
  cross-device restore of chat identity (wire v1's self-encrypted `31602`
  chat-device-key backup is retired, and existing ones are best-effort deleted on the
  first v2 chat session). A device is *added* by attestation and *removed* by
  revocation; a lost, evicted, or logged-out device is revoked from another
  still-logged-in device, not recovered. This removes v1's forkable
  competing-backup and account-signer-recovers-chat-key exposures entirely.
- **Devices and history.** Each device has its own MLS leaf and sees group history
  only from its own join epoch forward: history never syncs between devices (MLS
  semantics, by design). Browser eviction requires a fresh key package, coordinator
  re-add, and Welcome; history during the gap is lost to that client.
- **Recovery limits.** Normal logout self-encrypts local chat state, but a
  best-effort encryption failure can leave local plaintext. Coordinator database loss
  can orphan MLS administration; verified coordinator backups plus a second
  administrator are operational requirements, every approved organizer's attested
  chat devices are automatically promoted to MLS co-admins as the backstop when a
  backup is unavailable.

## Coordinator handover

When the organizer replaces a coordinator, the new one rebuilds the member list from
the previous roster (NIP §3.7). It trusts that roster only from the event identity
(`E_id`) or from the outgoing coordinator that the `E_id`-sealed install grant names
(`prev_coordinator`). Anyone holding an ECK, including a revoked attendee using a fresh
key, can encrypt a roster that decrypts correctly. Before this rule, such a roster could
make the attacker an approved organizer on the new coordinator: an MLS co-admin with
the current ECK. Two consequences remain:

- **A malicious outgoing coordinator is still trusted for the handover.** The organizer
  chose it and the grant names it, so its last roster is adopted. It can add pubkeys to
  that roster. Rotating the keys on replace limits what it can read afterwards, but not
  what it hands over. The roster is still bounded by the roster and attendee caps.
- **A grant from an older organizer client names no outgoing coordinator.** The new
  coordinator then adopts only an `E_id`-authored roster, plus the invite approvals it
  rebuilds from the inbox history. The client's replace flow rewrites the roster under
  `E_id`, so approvals normally survive. If that rewrite did not happen, the approvals
  are missing until the organizer re-approves those people.

## Revocation honesty

Rotation is **forward-only** (spec §6.3). Anyone who ever held a decryption key can
decrypt content published while that key was current, forever. Removing an attendee
mints ECK v(n+1), re-grants it to the remaining attendees, deletes the removed
directory entry (NIP-09), and encrypts all *future* content under the new key, 
protecting future content only. For conference intro videos and match lists (data
of bounded sensitivity and time-bounded relevance), this is an accepted trade-off,
stated in the UI where organizers configure events and where they revoke.

**Concurrent rotations across organizer devices.** Two organizer devices (or an
organizer and a co-organizer) that revoke at the same moment each mint "v(n+1)" with
different keys. The protocol keeps both keys everywhere and heals by a further rotation
(NIP §4.1), so no one loses access to content they held a key for. What it cannot
recover is the losing device's roster: a person removed only on that device is on the
surviving roster, and the repair re-grants everyone on it. The organizer is told to
check and revoke again. A co-organizer's account learns about a rotation only from the
fresh 21605 the rotating device re-issues; one this device never heard of (neither
granted by it nor named in a grant it received) stays on the old keys and sees "keys
changed on another device".

## Client hygiene

- Local keys in IndexedDB (not localStorage strings where avoidable).
- NIP-49 (`ncryptsec`) for any at-rest key export.
- `#/login?nsec=` is consumed and stripped from the URL/history immediately on open, and the key is imported only after the person confirms the account it belongs to (anyone can mint such a link for an identity they control).
- No third-party scripts. CSP: `default-src 'self'`; `connect-src` limited to
  `wss:`/`https:` (relays + Blossom).
- NIP-04 is lint-banned project-wide; NIP-44 is always requested with the scheme
  explicit.
- NIP-46 persisted client key and bunker capability are plaintext IndexedDB bearer
  capabilities while remembered on this origin; same-origin script compromise can
  use them within the remote signer's granted permissions.
