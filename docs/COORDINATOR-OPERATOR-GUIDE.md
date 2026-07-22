# Coordinator Operator Guide

**Status:** Operational guide for the current implementation. It documents required custody and recovery practice; it does not remove the known replay, ordering, billing, and stale-work limitations in the implementation.

## Before Running

- Use a stable coordinator identity. Protect `NOSTRAUTICA_COORDINATOR_NSEC` or the NIP-49 identity material with least-privilege filesystem permissions.
- Install Node 22.5+ and `ffmpeg`/`ffprobe`.
- Keep provider credentials, Cashu wallet material, and the SQLite database readable only by the coordinator service account.
- Configure only relays and providers you trust with the event data they will receive.
- Verify model privacy declarations against the actual runtime provider. Current runtime chooses one global LLM provider; do not rely on per-role provider configuration as enforcement.

## Durable State and Backups

The coordinator database contains more than a cache:

| State | Recovery property |
|---|---|
| Relay-backed event/config/content records and derived artifacts | Usually reconstructible, with relay/provider cost and availability consequences. |
| Job, dedupe, invite-claim, and Cashu journal records | Durable operational state; loss can replay work, lose queue context, or leave financial outcomes ambiguous. |
| Coordinator `E_inbox`/ECK custody | Encrypted at rest under the coordinator identity, but necessary to resume event processing. |
| Marmot `marmot_kv` and group administration state | Non-reconstructible from relay events; loss can orphan the coordinator's MLS admin role. |

Back up SQLite using a WAL-safe method while the database is consistent. Encrypt backups, keep the coordinator identity material needed to decrypt protected columns, and test restoration on an isolated host. A backup that has not been restored and exercised is not a recovery plan.

For Marmot events, enroll and verify a second administrator before relying on the chat. Before decommissioning a coordinator, define who retains group administration and test that handoff.

## Operations

- Run under a dedicated unprivileged account.
- Rotate logs and monitor disk, database growth, provider errors, and poisoned jobs.
- Apply resource limits and service sandboxing appropriate for processing untrusted media. Test ffmpeg under those restrictions before production use.
- On upgrade, take a verified backup first. Preserve the same coordinator identity unless the event migration has been designed and tested.
- On shutdown, prefer a controlled maintenance window. Current implementation limitations mean active jobs should be observed and the post-restart queue checked.

## Billing, Payment, and Detach

Current billing status is informational. The implementation evaluates against `E_id`, not a personal organizer identity, and does not enforce payment before expensive work. Cashu journal recovery can quarantine an ambiguous payment but does not fully reconcile it with a mint.

Coordinator detachment/reassignment and command replay have known implementation limitations. Do not treat a config edit alone as a verified immediate erasure of coordinator custody. Verify subscriptions, stored event state, and coordinator logs during an operational detach.

## Incident Response

1. Stop new deployment activity and preserve logs/database snapshots.
2. Determine whether the incident concerns provider exposure, key custody, relay delivery, payment ambiguity, or MLS state.
3. For an attendee revocation, use the product flow and verify ECK rotation, roster publication, and Marmot removal where enabled.
4. For suspected coordinator identity compromise, rotate infrastructure credentials, assess all installed event key custody, and coordinate event-owner migration before restarting under a replacement identity.
5. Document the event coordinate, coordinator pubkey, deployment revision, affected relays, and verified outcome.
