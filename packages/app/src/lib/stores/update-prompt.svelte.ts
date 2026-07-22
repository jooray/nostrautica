/**
 * "Update the app" prompt (NIP §2, decision D2). Wire v2 rejects any payload
 * whose protocol version is newer than this client understands. When such a
 * payload arrives from a TRUSTED AUTHORITY key — an event's E_id (its signed
 * 31600 config) or the configured coordinator (roster / key grant) — it means
 * the network has moved to a newer protocol and this client is stale. We flag a
 * one-line, dismissable banner prompting the user to update rather than silently
 * dropping their event.
 *
 * We deliberately only raise this for authority-signed payloads: a random hostile
 * relay event with `v:99` is "invalid", not "you are out of date", and must never
 * be able to nag every user into reloading.
 */
let needed = $state(false);

export const updatePrompt = {
  /** True once a newer-protocol payload was seen from a trusted authority key. */
  get needed() {
    return needed;
  },
  /** Flag that this client is behind the network's protocol version. Idempotent. */
  flag() {
    needed = true;
  },
  /** Apply the waiting service-worker update (autoUpdate reloads), else hard reload. */
  update() {
    const sw = (window as unknown as { __nostrauticaUpdateSW?: (r?: boolean) => void })
      .__nostrauticaUpdateSW;
    if (sw) sw(true);
    else window.location.reload();
  },
};
