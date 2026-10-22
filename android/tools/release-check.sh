#!/usr/bin/env bash
# Pre-release gate for the Android app (audit SB-55, SB-56). Run it before the
# `chore: release X.Y.Z` commit; it must end on "RELEASE CHECK OK".
#
#   android/tools/release-check.sh               versions, unit tests, assembleRelease, APK checks
#   android/tools/release-check.sh --skip-build  versions and APK checks on the APK already built
#
# It fails, saying why, when:
#   - versionName differs from the root package.json version;
#   - versionCode is not above the last published android-v* GitHub release
#     (Android and Zapstore refuse an equal or lower one), or versionName is not newer;
#   - the release signing properties are missing (no unsigned release);
#   - a unit test fails or assembleRelease fails;
#   - the APK is not signed by exactly the shared publisher key, or its package,
#     versionCode or versionName are not the ones in build.gradle.kts.
#
# The previous release's versionCode comes from the local v<versionName> tag's
# build.gradle.kts, or from the release's APK when the tag is missing. Offline,
# set PREV_VERSION_CODE (and PREV_VERSION_NAME) by hand.
#
# Environment: JAVA_HOME (default: Android Studio's JBR), ANDROID_HOME (default:
# ~/Library/Android/sdk), APP_SIGNING_PROPERTIES (default:
# ~/.apk-signing-keystore/signing.properties), GH_REPO (default: jooray/nostrautica).
set -euo pipefail

PUBLISHER_CERT_SHA256="79750fb49349ec3729be5a3e825507a15e47c6d987e854ae91d5d50a20b3a24d"
PACKAGE="today.cypherpunk.nostrautica"
GH_REPO="${GH_REPO:-jooray/nostrautica}"

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "!!! RELEASE CHECK FAILED: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

ANDROID_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$ANDROID_DIR/.." && pwd)"
GRADLE_FILE="$ANDROID_DIR/app/build.gradle.kts"
APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -x "$JAVA_HOME/bin/java" ] || fail "no java at JAVA_HOME=$JAVA_HOME (set JAVA_HOME to Android Studio's JBR)"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$BUILD_TOOLS" ] || fail "no build-tools under ANDROID_HOME=$ANDROID_HOME"
APKSIGNER="${BUILD_TOOLS}apksigner"
AAPT2="${BUILD_TOOLS}aapt2"
[ -x "$APKSIGNER" ] && [ -x "$AAPT2" ] || fail "apksigner/aapt2 missing in $BUILD_TOOLS"

# Is version $1 strictly newer than $2 (dotted numbers)?
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# ---------------------------------------------------------------------------
step "versions"
CODE="$(sed -n 's/^ *versionCode = \([0-9][0-9]*\).*/\1/p' "$GRADLE_FILE" | head -1)"
NAME="$(sed -n 's/^ *versionName = "\([^"]*\)".*/\1/p' "$GRADLE_FILE" | head -1)"
[ -n "$CODE" ] && [ -n "$NAME" ] || fail "could not read versionCode/versionName from $GRADLE_FILE"
ROOT_VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" | head -1)"
[ -n "$ROOT_VERSION" ] || fail "could not read the version from $REPO_DIR/package.json"
echo "build.gradle.kts: versionCode $CODE, versionName $NAME; root package.json: $ROOT_VERSION"
[ "$NAME" = "$ROOT_VERSION" ] ||
  fail "versionName $NAME differs from the root package.json version $ROOT_VERSION (bump them together, docs/VERSIONING.md)"

PREV_CODE="${PREV_VERSION_CODE:-}"
PREV_NAME="${PREV_VERSION_NAME:-}"
if [ -z "$PREV_CODE" ]; then
  command -v gh >/dev/null || fail "gh is not installed; set PREV_VERSION_CODE/PREV_VERSION_NAME to the last release's values"
  PREV_TAG="$(gh release list -R "$GH_REPO" -L 100 --json tagName --jq '.[].tagName' |
    grep '^android-v' | sed 's/^android-v//' | sort -V | tail -1)" ||
    fail "could not list the GitHub releases of $GH_REPO; set PREV_VERSION_CODE/PREV_VERSION_NAME by hand"
  if [ -z "$PREV_TAG" ]; then
    fail "no android-v* release on $GH_REPO; for the very first release set PREV_VERSION_CODE=0"
  fi
  PREV_NAME="$PREV_TAG"
  if git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/v$PREV_NAME" >/dev/null; then
    PREV_CODE="$(git -C "$REPO_DIR" show "v$PREV_NAME:android/app/build.gradle.kts" |
      sed -n 's/^ *versionCode = \([0-9][0-9]*\).*/\1/p' | head -1)"
    echo "last release: android-v$PREV_NAME, versionCode $PREV_CODE (from tag v$PREV_NAME)"
  else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    gh release download "android-v$PREV_NAME" -R "$GH_REPO" -p '*.apk' -D "$TMP" ||
      fail "no local tag v$PREV_NAME and could not download the android-v$PREV_NAME APK"
    PREV_CODE="$("$AAPT2" dump badging "$TMP"/*.apk | sed -n "s/.* versionCode='\([0-9]*\)'.*/\1/p" | head -1)"
    echo "last release: android-v$PREV_NAME, versionCode $PREV_CODE (from its APK)"
  fi
fi
[ -n "$PREV_CODE" ] || fail "could not determine the last release's versionCode"
[ "$CODE" -gt "$PREV_CODE" ] ||
  fail "versionCode $CODE is not above the last release's ($PREV_CODE, $PREV_NAME); Android and Zapstore refuse it"
if [ -n "$PREV_NAME" ]; then
  newer "$NAME" "$PREV_NAME" || fail "versionName $NAME is not newer than the last release's ($PREV_NAME)"
fi
echo "versions OK: $PREV_NAME ($PREV_CODE) -> $NAME ($CODE)"

# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  step "signing properties"
  PROPS="${APP_SIGNING_PROPERTIES:-$HOME/.apk-signing-keystore/signing.properties}"
  [ -f "$PROPS" ] || fail "release signing properties not found at $PROPS (set APP_SIGNING_PROPERTIES); refusing to build"
  STORE="$(sed -n 's/^storeFile=//p' "$PROPS" | head -1)"
  [ -n "$STORE" ] || fail "$PROPS has no storeFile"
  # Gradle resolves a relative storeFile against android/app, as file() does.
  case "$STORE" in /*) ;; *) STORE="$ANDROID_DIR/app/$STORE" ;; esac
  [ -f "$STORE" ] || fail "keystore $STORE (storeFile in $PROPS) does not exist"
  echo "signing with $STORE"

  # Always run the fetch, not only when the directory is missing. It is a no-op
  # when the unpacked copy matches the pinned version and checksum, and replaces
  # it otherwise. Only checking for the directory's existence is how 0.13.2
  # shipped with MarmotKit 0.12.0 (schema 101) while the repo pinned 0.13.0
  # (schema 107): an app whose account database 0.13.0 had already migrated then
  # refused to open it ("database schema version 107 is newer than the latest
  # supported version 101"). A release build must never trust whatever happens to
  # be unpacked in src/marmotkit.
  step "MarmotKit (pinned)"
  "$ANDROID_DIR/tools/marmotkit/fetch.sh"

  step "unit tests + assembleRelease"
  # A stale APK from an earlier build must not pass the checks below.
  rm -f "$APK"
  (cd "$ANDROID_DIR" && ./gradlew testDebugUnitTest :protocol:test assembleRelease)
fi

# ---------------------------------------------------------------------------
step "APK"
[ -f "$APK" ] || fail "no APK at $APK"
CERTS="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null)" || fail "apksigner verify rejected $APK"
SIGNERS="$(printf '%s\n' "$CERTS" | grep -c 'certificate SHA-256 digest:' || true)"
[ "$SIGNERS" = 1 ] || fail "expected exactly one signer, apksigner printed $SIGNERS"
CERT="$(printf '%s\n' "$CERTS" | sed -n 's/.*certificate SHA-256 digest: \([0-9a-f]*\).*/\1/p')"
[ "$CERT" = "$PUBLISHER_CERT_SHA256" ] ||
  fail "APK is signed by $CERT, not the shared publisher key $PUBLISHER_CERT_SHA256"
echo "signer: $CERT (shared publisher key)"

BADGING="$("$AAPT2" dump badging "$APK" | head -1)"
APK_PKG="$(printf '%s' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
APK_CODE="$(printf '%s' "$BADGING" | sed -n "s/.* versionCode='\([0-9]*\)'.*/\1/p")"
APK_NAME="$(printf '%s' "$BADGING" | sed -n "s/.* versionName='\([^']*\)'.*/\1/p")"
[ "$APK_PKG" = "$PACKAGE" ] || fail "APK package is $APK_PKG, expected $PACKAGE"
[ "$APK_CODE" = "$CODE" ] && [ "$APK_NAME" = "$NAME" ] ||
  fail "APK is $APK_NAME ($APK_CODE) but build.gradle.kts says $NAME ($CODE); rebuild"
echo "package: $APK_PKG $APK_NAME ($APK_CODE)"
echo "sha256:  $(shasum -a 256 "$APK" | cut -d' ' -f1)  $APK"

echo
echo "=== RELEASE CHECK OK: $PACKAGE $NAME ($CODE) ==="
