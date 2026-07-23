# Nostrautica — Threat Model

Finalized from SPECIFICATION.md §14 (spec is normative). This summarizes what the
system protects, what it deliberately leaks, and who must be trusted.

## Protected

- **Submission contents pre-approval.** Join requests + profile submissions are
  gift-wrapped to `E_inbox`; only `E_inbox` holders (organizer + attached
  coordinator) can read them.
- **Event content from non-attendees.** Intro videos, talks, directory entries,
  roster, and match matrix are encrypted under the Event Content Key (ECK), which
  only approved attendees receive (via a `21602` grant).
- **Match reasoning from everyone but the pair** (default `match_visibility:pair`).
  Each attendee's match list (`31605`) is NIP-44-encrypted coordinator→recipient,
  so a pair's score/reasoning is visible only to its two members.
- **User-private data** (favorites, want-to-meet, met, notes) — NIP-44
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
  "fresh copy" option — the identical ciphertext hash links their presence across
  events. Mitigation offered in-UI: "fresh copy" re-keys the blob to a new hash.
- **Timing correlation on relays** — relays see event timing/sizes/counts.
- **`E_inbox` p-tags on inbound wraps** mark that *someone* submitted (wrap authors
  are one-time keys, so not *who*).
- **Email backup of nsec** traverses email infrastructure — a user-chosen
  convenience trade-off (spec §5.2), stated plainly in the UI; the key rides the
  URL fragment (never sent to a server) but email itself is not confidential.
- **Event CSS is trusted-organizer UI control, not a secret-safe boundary.** It can
  spoof in-event UI and emit allowed image/network beacons. Some themed event
  routes currently reveal sensitive values; `font-src 'self'` limits one remote
  font exfiltration technique but does not make those surfaces safe.

## Trusted parties

- **Coordinator** — reads all event-encrypted content (it must, to transcribe
  videos). It is organizer-chosen infrastructure and is surfaced as such in the UI
  ("operated by `<npub>`"). It **cannot** impersonate the event or alter the public
  event/config/invites.
- **LLM / STT provider** — sees plaintext transcripts and summaries. Mitigations:
  v1 prefers Venice private/TEE-tier models (`require_private`); v2 uses
  operator-chosen Routstr nodes.
- **Relays / Blossom** — see ciphertext + metadata only.

## Marmot MLS chat

- **Coordinator authority.** The coordinator is an MLS group member/admin and can
  read group chat. It adds/removes members and therefore needs durable MLS state.
- **Chat identity.** Local-key accounts use their account key as their chat
  identity. NIP-07/NIP-46 accounts use an app-held chat device key, authorized to
  the coordinator by an account-sealed `21607`. That attestation proves account
  authorization, not possession of the attested chat private key.
- **Relay backup.** A remote-signer device key is self-encrypted to the account and
  published in a blinded replaceable `31602` entry. It contains only the raw
  32-byte identity key, not MLS group/epoch state, membership state, or history.
  Relays still observe the author and timing. Compromise of the account signer can
  recover this stable chat identity key.
- **Devices and history.** A restored identity may be used on another device, but
  each device has its own MLS leaf and sees only from its own join epoch. Browser
  eviction requires a fresh key package, coordinator re-add, and Welcome; history
  during the gap is lost to that client.
- **Recovery limits.** Backup fetch failure is not equivalent to confirmed absence;
  competing replaceable backups and multi-tab state can fork identity/state. Normal
  logout encrypts chat state, but best-effort encryption failure can leave local
  plaintext. Coordinator database loss can orphan MLS administration; verified
  backups and a second administrator are operational requirements.

## Revocation honesty

Rotation is **forward-only** (spec §6.3). Anyone who ever held a decryption key can
decrypt content published while that key was current, forever. Removing an attendee
mints ECK v(n+1), re-grants it to the remaining attendees, deletes the removed
directory entry (NIP-09), and encrypts all *future* content under the new key —
protecting future content only. For conference intro videos and match lists — data
of bounded sensitivity and time-bounded relevance — this is an accepted trade-off,
stated in the UI where organizers configure events and where they revoke.

## Client hygiene

- Local keys in IndexedDB (not localStorage strings where avoidable).
- NIP-49 (`ncryptsec`) for any at-rest key export.
- `#/login?nsec=` is consumed and stripped from the URL/history immediately on open.
- No third-party scripts. CSP: `default-src 'self'`; `connect-src` limited to
  `wss:`/`https:` (relays + Blossom).
- NIP-04 is lint-banned project-wide; NIP-44 is always requested with the scheme
  explicit.
- NIP-46 persisted client key and bunker capability are plaintext IndexedDB bearer
  capabilities while remembered on this origin; same-origin script compromise can
  use them within the remote signer's granted permissions.
