import { unixNow } from "../utils/nostr.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "./protocol.js";
import { getKeyPackageIdentifier } from "./key-package-event-decode.js";
/**
 * Creates a NIP-09 delete event (kind 5) to delete one or more KeyPackage
 * events (kind 30443).
 *
 * Both an `e` tag (event id) and an `a` tag (addressable coordinate) are
 * included so relays can match either way. String-only inputs produce only an
 * `e` tag since no pubkey/d is available.
 */
export function createDeleteKeyPackageEvent(options) {
    const { events } = options;
    if (!events || events.length === 0) {
        throw new Error("At least one event must be provided for deletion");
    }
    const eTags = [];
    const aTags = [];
    for (const e of events) {
        if (typeof e === "string") {
            // String id only — no kind info available, emit e tag without k inference
            eTags.push(["e", e]);
        }
        else {
            if (e.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) {
                throw new Error(`Event ${e.id} is not a key package event (kind ${e.kind} instead of ${ADDRESSABLE_KEY_PACKAGE_KIND})`);
            }
            eTags.push(["e", e.id]);
            const identifier = getKeyPackageIdentifier(e);
            if (identifier !== undefined) {
                aTags.push([
                    "a",
                    `${ADDRESSABLE_KEY_PACKAGE_KIND}:${e.pubkey}:${identifier}`,
                ]);
            }
        }
    }
    // All KeyPackage events are kind 30443.
    const kTags = [["k", String(ADDRESSABLE_KEY_PACKAGE_KIND)]];
    return {
        kind: 5,
        created_at: unixNow(),
        content: "",
        tags: [...kTags, ...eTags, ...aTags],
    };
}
//# sourceMappingURL=key-package-event-delete.js.map