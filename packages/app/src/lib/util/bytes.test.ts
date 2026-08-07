import { describe, it, expect } from "vitest";
import { formatBytes } from "./bytes.js";

describe("formatBytes", () => {
  it("scales units and handles zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1000)).toBe("1.0 KB");
    expect(formatBytes(5_000_000)).toBe("5.0 MB");
    expect(formatBytes(150_000_000)).toBe("150 MB");
  });

  it("uses decimal units, so a labelled GB is 10^9 bytes and not a GiB", () => {
    // Regression: this divided by 1024 while labelling the output "KB/MB/GB",
    // so every figure read ~7% low by the GB step.
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
    expect(formatBytes(9_999_999_999)).toBe("10.0 GB");
  });
});
