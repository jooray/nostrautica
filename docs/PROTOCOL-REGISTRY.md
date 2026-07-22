# Nostrautica Protocol Registry

**Status:** Normative registry for implemented custom events. `packages/protocol/src/kinds.ts` and its Zod schemas are the implementation reference; this document records the interoperable contract and must be updated in the same change as a new custom kind.

All custom payloads use `v: 1`. Addressable events use normal Nostr replaceable/addressable latest-event rules: compare `created_at`, then event ID as a deterministic tie-break where the implementation has one. Gift-wrapped rumors are delivered only inside kind `1059` wraps; their seal author is the authenticated author.

## Addressable Events

| Kind | Name | Author | Protection and address | Content / authority | Lifecycle |
|---:|---|---|---|---|---|
| 31600 | Event Networking Config | `E_id` | Public; `d` = calendar-event `d`; `a` = event coordinate | Tags configure inbox, relays, Blossom, coordinator, limits, approval, matching, language, talks, and chat. Only `E_id` may publish. | Newest valid config wins. A coordinator must not treat a missing or invalid current assignment as authorization. |
| 31601 | Invite List | `E_id` | Public; `d` = event `d`; `a` = event coordinate | JSON invite hash list. Only `E_id` may publish. | Republishing adds or removes invite hashes. Relay propagation is eventually consistent. |
| 31602 | Self-encrypted profile, reuse library, or chat device-key backup | Attendee account | NIP-44 self-encrypted; blinded `d` | Event profile uses `a = <coordinate>`. Reuse library uses `a: null` and the `library` blinded `d`. Chat backup uses `a: null`, a blinded `chat-device-key` `d`, and strict `{v,a,chat_device_key}` content. | Latest entry per address wins. Chat backup contains identity key only, never group/epoch/history state. |
| 31603 | Directory Entry | Coordinator, or `E_id` without a coordinator | ECK-encrypted; ECK-blinded `d`; `a` = event coordinate | Profile/media/transcript/derived profile for one approved attendee. Publisher and ECK version are tagged. | Replaced when profile/derived output changes; NIP-09 deletion is requested on revocation. |
| 31604 | Roster | Coordinator, or `E_id` without a coordinator | ECK-encrypted; `d` = event `d` | Approved attendee index, current ECK, optional chat account keys, and optional active Marmot `nostr_group_id`. | Latest valid roster wins. `nostr_group_id` is the authoritative event-to-group routing ID when present. |
| 31605 | Match List | Coordinator | NIP-44 coordinator-to-recipient; ECK-blinded `d`; `a` = event coordinate | Directional match reasoning for one recipient. | Replaced after scoring or ECK rotation. |
| 31606 | Match Matrix | Coordinator | ECK-encrypted; `d` = event `d`; `a` = event coordinate | Event-wide score-only matrix; only for `match_visibility: event`. | Replaced after recomputation; deleted when visibility changes away from event-wide. |
| 31607 | Members-only Event Post | `E_id` | ECK-encrypted; random stable `d`; `eck` tag | Official members-only post and metadata. | Same `d` edits; old ciphertext remains readable to previous ECK holders. |
| 31608 | Event Page | `E_id` | Public sections plus optional ECK-encrypted private sections; `d` = event `d` | Official menu and layout. | Latest valid event page wins. |
| 31609 | Event Theme | `E_id` | Public raw CSS; `d` = event `d` | Organizer-controlled event presentation. | Latest theme wins. Themes are not a secret-safe boundary. |
| 31610 | Talk | Coordinator, or `E_id` without a coordinator | ECK-encrypted; talk/ECK-blinded `d`; `a` = event coordinate | Moderated prerecorded talk, transcript, language, revision, and status. | Republished after moderation/transcription/ECK rotation; obsolete addresses may receive NIP-09 deletions. |
| 31611 | Coordinator Announcement | Coordinator | Public; `d = nostrautica:coordinator` | Discovery name, capabilities, privacy disclosure, relays, and optional pricing. | Latest announcement per coordinator wins. Declared pricing is informational until enforcement exists. |

## Gift-Wrapped Rumors

| Kind | Name | Seal author and recipient | Content / authority | Lifecycle |
|---:|---|---|---|---|
| 21600 | Join Request | Attendee account -> `E_inbox` | Display name, message, RSVP, optional invite proof. | Latest request presentation is selected by source ordering; coordinator/organizer dedupe is required. |
| 21601 | Profile Submission | Attendee account -> `E_inbox` | Authored event profile, media descriptors, optional text intro. | Mutable submission. Implementations must define durable ordering before applying out-of-order delivery. |
| 21602 | Key Grant | Organizer/coordinator -> attendee | ECK versions and attendee/organizer role. | New grants merge ECK custody; they do not erase newer known versions. |
| 21603 | Coordinator Grant | `E_id` -> coordinator | Event coordinate, `E_inbox` secret, ECK versions, config relays. | Authenticated installation grant. It is not a personal-organizer billing identity. |
| 21604 | Admin Command | `E_id` -> coordinator | Approve, recompute, reprocess, revoke, talk publish, or talk reject command. | Commands need durable replay and ordering protection. |
| 21605 | Organizer Grant | `E_id`/organizer authority -> co-organizer | Full `E_id`, `E_inbox`, ECK, and relay custody. | Grants full event authority; scoped organizer roles are not implemented. |
| 21606 | Coordinator Status | Coordinator -> `E_id` | Poison/health status and optional informational billing block. | Latest status is advisory. Billing/payment enforcement is not implemented. |
| 21607 | Chat-key Attestation | Attendee account -> coordinator | Adds or revokes a remote-signer chat device public key. | Proves account authorization, not possession of the attested private key. |
| 21608 | Profile Correction | Attendee account -> `E_inbox` | Corrects or hides fields of the sender's derived profile. | Coordinator stores and reapplies corrections on publication. |
| 21609 | Talk Submission | Attendee account -> `E_inbox` | Talk metadata, talk media, and revision. | Implementations must reject stale revisions rather than applying relay arrival order. |

## Standard Events Used by the Application

The protocol additionally uses standard Nostr kinds: kind `0` metadata, `1` notes, `3` contacts, `5` deletions, `6` reposts, `13` seals, `14` NIP-17 direct-message rumors, `1059` gift wraps, `10002` relay lists, `10050` DM relay lists, `10063` Blossom server lists, `24242` Blossom authorization, `30023` long-form posts, `30078` app data, and `31923`/`31924`/`31925` NIP-52 event/calendar/RSVP records.

Before a public release, re-check every custom kind in the Nostr NIPs registry. The currently used custom set is exactly `31600` through `31611` and `21600` through `21609`.
