# Nostrautica for Android

The native Android app for Nostrautica: the same events, people, matches,
intros, talks, posts, direct messages, group chat and organizer tools as the
PWA in `packages/app`, talking to the same relays, Blossom servers and
coordinator. There is no app server: everything the PWA does in the browser
(NIP-44 envelopes, event keys, gift wraps, MLS) happens on the phone.

## Build and run

Toolchain (Android Studio's own):

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd android
tools/marmotkit/fetch.sh          # MarmotKit (MDK) bindings + native libs, pinned and SHA-256-checked
./gradlew assembleDebug testDebugUnitTest :protocol:test
```

- Gradle 9.7.1 (wrapper), AGP 9.4.1 (built-in Kotlin), Kotlin 2.4.20,
  compileSdk/targetSdk 37, minSdk 26.
- Debug APK: `app/build/outputs/apk/debug/app-debug.apk`, application id
  `today.cypherpunk.nostrautica.debug` (installs next to a release build).
- MarmotKit is ~180 MB unpacked (four ABIs), so it is fetched, never committed.
  Bumping it: read every MDK integration guide between the versions
  (`marmot-protocol/mdk` `docs/integration/`), then update the version and the
  checksum file in `tools/marmotkit/`.

### Against the local test stack

The PWA's e2e infrastructure works for the app too (no Playwright needed):

```sh
nak serve --port 7777 --hostname 0.0.0.0 &
node e2e/local-infra/blossom.mjs 3000 &
MOCK_RELAY=ws://localhost:7777 node e2e/local-infra/mock-coordinator-chat.mjs &   # coordinator double, real Marmot admin bot
adb reverse tcp:7777 tcp:7777 && adb reverse tcp:3000 tcp:3000
./gradlew assembleDebug -PdevRelays=ws://127.0.0.1:7777 -PdevBlossom=http://127.0.0.1:3000
```

`-PdevRelays` / `-PdevBlossom` replace the default relays and Blossom servers
(like the PWA's `VITE_NOSTRAUTICA_RELAYS`), and make MDK accept loopback
relays. Use `127.0.0.1` through `adb reverse`, not `10.0.2.2`: MDK allows
plain `ws://` for loopback only. Video/audio intros need HTTPS Blossom, as in
the PWA (`docs/E2E-TESTING-GUIDE.md` §1.1.1); text intros work locally.

### Strings

UI text is the PWA's: `tools/strings/generate.mjs` turns
`packages/app/src/lib/i18n/messages.ts` (en, sk, cs, de, es) plus the few
native-only strings in `tools/strings/app-messages*.json` into
`app/src/main/assets/i18n/*.json`. Rerun it after changing either, and after
merging branches that both regenerated the catalogs. `I18n.kt` is a port of
`i18n.svelte.ts` (fallbacks, `{name}` placeholders, sk/cs `few` plurals,
community variants, the event-language switch). `StringsTest` fails if the
code asks for a key that doesn't exist or a locale is missing one.

## Architecture

```
protocol/   packages/protocol in Kotlin, pure JVM: NIP-01/19/44/49/59, blinded d,
            invite and chat-device proofs, AES-GCM media, 31600 config, roster
            pagination, payload schemas. Tested against vectors produced by the
            TS implementation (tools/vectors/generate.mjs) and the NIP-44 suite.
app/
  nostr/    RelayPool (OkHttp WebSockets), Nostr (fetch → store, durable outbox), Relays
  data/     Room: verified events (latest-wins replaceables, tag index), the
            owner-scoped cache, the outbox
  signer/   local key (Keystore-wrapped), NIP-55 (Amber), NIP-46, NIP-49, Session
  domain/   ports of lib/events: event keys, contexts, grants, members, membership,
            social; and per area: people/, join/, media/, organizer/, dm/, chat/, content/
  ui/       Compose: shell (bottom bars gated like EventNav.svelte), screens per area
```

Routes are the PWA's (`ui/nav/Route.kt` ports `routes.ts`), so every web link,
invite links with `?code=…&lang=…` included, opens the same screen; the app
claims `https://nostrautica.cypherpunk.today/app` and `nostr:naddr…` links.
The https links are verified app links: `web/.well-known/assetlinks.json`
(deployed with the landing page) names `today.cypherpunk.nostrautica` and the
release key's SHA-256, so Android opens them in the app without a chooser.
Debug builds are not verified. Changing the signing key means updating that
file; `AppLinksTest` pins it to the manifest and the key.

### Data, battery, offline

- Relay sockets open only when a screen needs them, close after 45 s idle and
  30 s after the app leaves the foreground. **Nothing runs in the background.**
- Every screen paints from the on-device store first and asks relays only when
  its data is older than a TTL (minutes). Live subscriptions (DM thread, admin
  inbox, chat) exist only while that screen is visible.
- Writes go through a durable outbox and are retried on reconnect/foreground.
- Remote signers are never prompted by background work (`silently {}`), and
  every gift wrap is decrypted at most once (`Accounts.unwrap` caches the rumor).

### Sign-in

A key on the phone (created invisibly at join/create, or an imported
nsec/ncryptsec), a signer app on the phone over NIP-55 (Amber: content
provider first, its activity only when it must ask, launched once we're
resumed), or NIP-46 (`nostrconnect://` QR/open-in-signer, `bunker://`).

### Group chat

MarmotKit (MDK's UniFFI bindings), loaded on first chat use only. Each phone
has its own chat device key, minted by MDK (`createIdentity`) and attested to
the account with a 21607 like the PWA's devices. A group is used only when its
`nostr_group_id` matches the roster's. MDK runs only while the chat screen is
open (closed 20 s after). Note: MDK's `createIdentity` sends best-effort copies
of the device key's relay lists and default kind-0 to public indexers.

## Release

Release builds are R8-minified, arm64-v8a only (MarmotKit is ~20 MB per ABI
compressed), with compressed native libraries (~27 MB APK). Signing uses the
shared publisher key from `~/.apk-signing-keystore/signing.properties` (or
`APP_SIGNING_PROPERTIES`); without it `assembleRelease` fails rather than
produce an unsigned APK (`-PunsignedRelease=true` opts out deliberately).

For every release, bump `versionCode` and `versionName` in
`app/build.gradle.kts`. `versionName` must equal the root `package.json`
version (`docs/VERSIONING.md`), and `assembleRelease` fails when it doesn't.
Then run the release check, which must end on `RELEASE CHECK OK`:

```sh
android/tools/release-check.sh
```

It checks, in order:

1. `versionName` equals the root version and is newer than the last
   `android-v*` GitHub release. `versionCode` is above that release's, which
   it reads from the local `v<version>` tag, or from the release's APK when
   the tag is missing. Offline, set `PREV_VERSION_CODE` and
   `PREV_VERSION_NAME`.
2. The signing properties and keystore exist.
3. `./gradlew testDebugUnitTest :protocol:test assembleRelease` passes. A
   stale APK is deleted first.
4. `apksigner` finds exactly one signer, the shared publisher key
   `79750fb49349ec3729be5a3e825507a15e47c6d987e854ae91d5d50a20b3a24d`.
   `aapt2` shows the package `today.cypherpunk.nostrautica` and the
   expected `versionCode`/`versionName`.

The script prints the APK's SHA-256 for the release notes.
`--skip-build` re-checks an APK that is already built. The same key's
fingerprint is in `web/.well-known/assetlinks.json` (verified app links).
Distribution is Zapstore/Obtainium/direct APK, not Google Play.
