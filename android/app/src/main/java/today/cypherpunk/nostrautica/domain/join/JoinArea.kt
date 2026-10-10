package today.cypherpunk.nostrautica.domain.join

import today.cypherpunk.nostrautica.AppContainer
import today.cypherpunk.nostrautica.domain.media.BlossomClient
import today.cypherpunk.nostrautica.domain.media.IntroMedia

/**
 * The join / intro / my-profile area's services, registered lazily from here so
 * no shared file needs editing. [blossom] is meant for every feature that uploads
 * (avatars, event images, encrypted media): `container.blossom`.
 */
val AppContainer.blossom: BlossomClient get() = area("blossom") { BlossomClient(http) }

val AppContainer.introMedia: IntroMedia get() = area("introMedia") { IntroMedia(nostr, cache, accounts, members, blossom) }

val AppContainer.joinFlow: JoinFlow get() = area("joinFlow") { JoinFlow(nostr, accounts, introMedia, eventKeys) }

val AppContainer.readiness: ReadinessTracker get() = area("readiness") { ReadinessTracker(nostr, cache, members, grants, introMedia) }
