import { getEventHash } from "applesauce-core/helpers/event";
import { serializeApplicationRumor } from "../../core/group-message.js";
import { unixNow } from "../../utils/nostr.js";
/**
 * Builds an unsigned kind 9 chat rumor with its `id` filled in.
 *
 * This is app-level convenience: kind 9 is a chat convention, not part of the
 * Marmot protocol. Pair it with {@link createApplicationMessageIntent} and
 * drive the result through {@link GroupSession.send} /
 * {@link GroupsManager.send}.
 */
export function createChatRumor(options) {
    const rumor = {
        id: "",
        kind: 9,
        pubkey: options.pubkey,
        created_at: options.created_at ?? unixNow(),
        content: options.content,
        tags: options.tags ?? [],
    };
    rumor.id = getEventHash(rumor);
    return rumor;
}
/**
 * Serializes an unsigned application rumor into an `applicationMessage` session
 * intent ready for {@link GroupSession.send} or {@link GroupsManager.send}.
 *
 * The rumor must be unsigned and is serialized per the Marmot spec before being
 * encrypted via MLS.
 */
export function createApplicationMessageIntent(rumor) {
    return {
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
    };
}
//# sourceMappingURL=application-message.js.map