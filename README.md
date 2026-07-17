# Nostrautica

A Nostr-native event organizer built around **networking, not just attendance**.
Attendees record short intro videos and optional talks; an AI coordinator
transcribes them, enriches them with each person's existing Nostr content, and
tells every attendee **who they should meet and why** — scoring pairs on
similarity *and* complementarity of skills, with plain-language reasoning.

**Try it live:** [nostrautica.cypherpunk.today](https://nostrautica.cypherpunk.today) —
the app is at `/app`, docs at `/docs`. Nothing to install; it's a static PWA that talks
only to Nostr relays and Blossom servers.

See [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) (normative) and
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). Product pitch:
[`docs/ELEVATOR-PITCH-en.md`](docs/ELEVATOR-PITCH-en.md). Guides:
[organizer](docs/ORGANIZER-GUIDE.md) · [participant](docs/PARTICIPANT-GUIDE.md).

## What's here

| Package | What it is |
|---|---|
| `packages/protocol` | Shared kinds, zod schemas, and crypto (ECK/NIP-44, blinded d-tags, AES-GCM media, invite proofs, NIP-59 gift wrap). Zero UI/server deps. |
| `packages/app` | The PWA — static SvelteKit (Svelte 5 runes), hash-routed, talks only to relays + Blossom. Deployable as an [nsite](https://github.com/sandwichfarm/nsyte) or any static host. |
| `packages/coordinator` | The optional headless daemon: STT → AI profiles → complementarity-aware matchmaking. Nostr-only interface; no HTTP surface. |

## Architecture

- **All application state lives in Nostr events**; media lives on Blossom servers
  (AES-GCM ciphertext). The PWA and the coordinator communicate **only through
  relays** (encrypted events) — there is no app server.
- **Privacy tiers** (spec §4.1): public (NIP-52 event, profiles), event-encrypted
  (videos, directory, roster — under the Event Content Key), pair-encrypted (match
  lists, coordinator→recipient), user-private (favorites/notes, self-encrypted).
- **Two event keypairs** (spec §6.1): `E_id` signs the public event/config/invites;
  `E_inbox` receives inbound submissions. The coordinator gets `E_inbox` but never
  `E_id` — it can read event content but cannot impersonate the event.

See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) for what's protected, what leaks
(and why it's accepted), and who's trusted.

## Develop

```sh
corepack enable                       # pnpm
pnpm install
pnpm --filter @nostrautica/protocol build
pnpm check                            # lint + typecheck + test (all packages)

pnpm --filter @nostrautica/app dev    # the PWA
pnpm --filter @nostrautica/app build  # static output → packages/app/build
```

Requires Node ≥ 22.5 (the coordinator uses the built-in `node:sqlite`) and
`ffmpeg`/`ffprobe` for the coordinator's audio pipeline.

Integration/e2e dev infra (a local relay + Blossom server):

```sh
docker compose -f docker/docker-compose.yml up
```

## Deploy

- **PWA** → nsite (`nsyte deploy`, kinds 15128/35128 + Blossom) and/or any static
  host. See [`packages/app/README-deploy.md`](packages/app/README-deploy.md).
- **Coordinator** → `docker/coordinator.Dockerfile` (node + ffmpeg), configured by
  [`packages/coordinator/coordinator.example.toml`](packages/coordinator/coordinator.example.toml)
  + env secrets. Installed per-event by a `21603` grant — no per-event server config.

## Providers

All AI I/O goes through three interfaces (`packages/coordinator/src/providers/types.ts`):
`SttProvider`, `LlmProvider`, `PaymentStrategy`. v1 ships Venice.ai adapters
(`Authorization: Bearer`); v2 adds Routstr (decentralized, Cashu-paid) behind a
config flag. STT stays on Venice/local (Routstr has no STT today).

## License

MIT — free and open source.
