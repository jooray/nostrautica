/**
 * A read that came back with nothing while no relay said EOSE (see
 * `StreamHandle.answered`). Thrown by refresh paths whose callers have something
 * cached on screen: "unknown" must not be presented, or cached, as "none".
 */
export class RelaysUnansweredError extends Error {
  constructor() {
    super("No relay answered, so nothing was refreshed.");
    this.name = "RelaysUnansweredError";
  }
}
