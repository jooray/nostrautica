import { describe, it, expect, vi } from "vitest";
import { runRowAction } from "./row-action.js";
import { SettingsUnreadableError } from "./settings.js";

// Audit KIMIK31 W-17: People's "want to meet" swallowed every failure.
describe("runRowAction", () => {
  it("reports a failure and keeps the previous state", async () => {
    const before = { want_to_meet: ["a"] };
    const onError = vi.fn();
    const err = new SettingsUnreadableError();
    const after = await runRowAction(() => Promise.reject(err), before, onError);
    expect(after).toBe(before);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("returns the new state and reports nothing on success", async () => {
    const onError = vi.fn();
    const next = { want_to_meet: ["a", "b"] };
    expect(await runRowAction(async () => next, { want_to_meet: ["a"] }, onError)).toBe(next);
    expect(onError).not.toHaveBeenCalled();
  });
});
