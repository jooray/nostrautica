/** Opens a pass from one monotonic-clock sample. */
export function openConvergencePass(nowMs, maxDurationMs, generation, baseEpoch = 0) {
    return {
        generation,
        openedAtMs: nowMs,
        deadlineMs: nowMs + maxDurationMs,
        lastRelevantInputMs: nowMs,
        baseEpoch,
    };
}
/** Restarts quiescence without changing a pass's identity or absolute deadline. */
export function refreshConvergencePass(pass, nowMs) {
    return { ...pass, lastRelevantInputMs: nowMs };
}
