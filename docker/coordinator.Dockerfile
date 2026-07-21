# Coordinator daemon image (spec §11): node + ffmpeg, single process + SQLite volume.
# Pinned to an exact Node 22 LTS (audit Q14): one Node major everywhere, no mutable
# base tags. Node 22.5+ is required for the built-in node:sqlite store (see README).
FROM node:22.14.0-bookworm-slim

# ffmpeg + ffprobe are required (audio extraction, spec §9.2). whisper.cpp is
# optional (local-whisper STT) and not installed here by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/coordinator ./packages/coordinator

RUN pnpm install --frozen-lockfile --filter @nostrautica/coordinator... \
  && pnpm --filter @nostrautica/protocol build \
  && pnpm --filter @nostrautica/coordinator build

# Run as a dedicated non-root user (audit COORD-19). /data is chowned so the
# SQLite volume is writable; a named volume initialized from the image keeps
# this ownership (for a bind mount, chown the host dir to uid 10001).
RUN groupadd --system --gid 10001 nostrautica \
  && useradd --system --gid nostrautica --uid 10001 --no-create-home nostrautica \
  && mkdir -p /data \
  && chown -R nostrautica:nostrautica /data /app

# SQLite cache/queue lives on a volume (loss re-derives, never corrupts — §9.1).
VOLUME ["/data"]
ENV NOSTRAUTICA_COORDINATOR_DB=/data/coordinator.sqlite

USER nostrautica
ENTRYPOINT ["node", "packages/coordinator/dist/main.js"]
CMD ["/data/coordinator.toml"]
