import { fetchDmRelays, selectDmRelays } from "$lib/events/dm.js";
import { DEFAULT_RELAYS, unionRelays } from "./relays.js";
import { publishOrQueue } from "./publish-queue.js";

/** Publish an account-addressed wrap to its NIP-17 inboxes plus event/app relays. */
export async function publishAccountGiftWrap(
  wrap: Parameters<typeof publishOrQueue>[0],
  recipient: string,
  eventRelays: string[],
): Promise<boolean> {
  const recipientRelays = await fetchDmRelays(recipient).catch(() => []);
  const relays = selectDmRelays(recipientRelays, unionRelays(eventRelays, DEFAULT_RELAYS));
  return publishOrQueue(wrap, relays);
}
