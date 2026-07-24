# Coordinator daemon image (spec §11): node + ffmpeg, single process + SQLite volume.
# Pinned to an exact Node 22 LTS by DIGEST (audit O1/Q14): one Node major
# everywhere and a fully immutable base — the tag documents intent, the @sha256
# digest is what actually gets pulled, so a re-tag upstream can't change the build.
# Node 22.5+ is required for the built-in node:sqlite store (see README).
# Digest is for node:22.14.0-bookworm-slim; refresh with:
#   docker manifest inspect node:22.14.0-bookworm-slim
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b

# ffmpeg + ffprobe are required (audio extraction, spec §9.2). whisper.cpp is
# optional (local-whisper STT) and not installed here by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
# Everything a frozen install needs to resolve BEFORE the sources (audit O1):
#   - pnpm-lock.yaml     — required by --frozen-lockfile.
#   - patches/           — pnpm-workspace.yaml's patchedDependencies (tseep) is
#                          applied during install; the patch file must be present
#                          or the install aborts.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY patches ./patches
# Every workspace package in the coordinator's dependency closure must exist on
# disk for the workspace graph to resolve: the protocol package, and the vendored,
# committed-pre-built Marmot/MLS packages (marmot-ts → ts-mls, both workspace:*).
COPY packages/protocol ./packages/protocol
COPY packages/coordinator ./packages/coordinator
COPY packages/vendor/marmot-ts ./packages/vendor/marmot-ts
COPY packages/vendor/ts-mls ./packages/vendor/ts-mls

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
