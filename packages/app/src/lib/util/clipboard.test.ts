import { describe, it, expect, vi, afterEach } from "vitest";
import { copyText } from "./clipboard.js";

describe("copyText (audit U15)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = vi.fn().mockReturnValue(true);
    stubDocument(exec);
    await expect(copyText("secret")).resolves.toBe("copied");
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when the Clipboard API is absent", async () => {
    vi.stubGlobal("navigator", {}); // no clipboard
    const exec = vi.fn().mockReturnValue(true);
    stubDocument(exec);
    await expect(copyText("x")).resolves.toBe("copied");
  });

  it("reports failure when neither path works", async () => {
    vi.stubGlobal("navigator", {}); // no clipboard
    const exec = vi.fn().mockReturnValue(false);
    stubDocument(exec);
    await expect(copyText("x")).resolves.toBe("failed");
  });

  it("reports failure (never throws) when there is no document either", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
    await expect(copyText("x")).resolves.toBe("failed");
  });

  function stubDocument(exec: (c: string) => boolean) {
    const el = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select: () => {},
      setSelectionRange: () => {},
      remove: () => {},
    };
    vi.stubGlobal("document", {
      body: { appendChild: () => {} },
      createElement: () => el,
      execCommand: exec,
    });
  }
});
