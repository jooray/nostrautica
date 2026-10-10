#!/bin/sh
# Fetch MarmotKit (MDK's UniFFI Kotlin bindings + Android native libraries) at the
# pinned release, verify it, and unpack it where app/build.gradle.kts looks.
# The archive is ~180 MB unpacked, so it is never committed.
#
#   android/tools/marmotkit/fetch.sh            # pinned version
#   MARMOTKIT_VERSION=0.12.1 MARMOTKIT_SHA256=… android/tools/marmotkit/fetch.sh
#
# Bumping MDK: read every integration guide between the two versions
# (marmot-protocol/mdk docs/integration/), then update both pins below.
set -eu
VERSION="${MARMOTKIT_VERSION:-0.12.0}"
SHA256="${MARMOTKIT_SHA256:-$(cat "$(dirname "$0")/marmotkit-$VERSION.sha256" 2>/dev/null | cut -d' ' -f1)}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$HERE/app/src/marmotkit"
STAMP="$DEST/.version"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$VERSION $SHA256" ]; then
  echo "MarmotKit $VERSION already present"; exit 0
fi
[ -n "$SHA256" ] || { echo "no checksum pinned for MarmotKit $VERSION" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ZIP="marmotkit-android-$VERSION.zip"
curl -fsSL -o "$TMP/$ZIP" "https://github.com/marmot-protocol/mdk/releases/download/marmotkit-v$VERSION/$ZIP"
echo "$SHA256  $TMP/$ZIP" | shasum -a 256 -c -
unzip -q "$TMP/$ZIP" -d "$TMP/x"
SRC="$TMP/x/marmotkit-android-$VERSION"
rm -rf "$DEST"; mkdir -p "$DEST"
cp -R "$SRC/kotlin" "$DEST/kotlin"
cp -R "$SRC/jniLibs" "$DEST/jniLibs"
cp "$SRC/manifest.json" "$SRC/android-elf.json" "$DEST/"
echo "$VERSION $SHA256" > "$STAMP"
echo "MarmotKit $VERSION installed in app/src/marmotkit"
