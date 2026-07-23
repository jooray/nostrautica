import { describe, it, expect } from "vitest";
import { classifyDeviceError, deviceErrorMessageKey } from "./device-error.js";

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe("classifyDeviceError", () => {
  it("maps permission failures to denied", () => {
    expect(classifyDeviceError(domError("NotAllowedError"))).toBe("denied");
    expect(classifyDeviceError(domError("SecurityError"))).toBe("denied");
    expect(classifyDeviceError(domError("PermissionDeniedError"))).toBe("denied");
  });

  it("maps missing-device failures to absent", () => {
    expect(classifyDeviceError(domError("NotFoundError"))).toBe("absent");
    expect(classifyDeviceError(domError("DevicesNotFoundError"))).toBe("absent");
  });

  it("maps in-use failures to busy", () => {
    expect(classifyDeviceError(domError("NotReadableError"))).toBe("busy");
    expect(classifyDeviceError(domError("TrackStartError"))).toBe("busy");
  });

  it("maps missing API / bad constraints to unsupported", () => {
    expect(classifyDeviceError(new TypeError("undefined is not a function"))).toBe("unsupported");
    expect(classifyDeviceError(domError("OverconstrainedError"))).toBe("unsupported");
  });

  it("falls back to unknown for unrecognized errors", () => {
    expect(classifyDeviceError(domError("WeirdError"))).toBe("unknown");
    expect(classifyDeviceError("just a string")).toBe("unknown");
  });

  it("builds a medium-specific message key", () => {
    expect(deviceErrorMessageKey("denied", false)).toBe("record.deviceError.denied.camera");
    expect(deviceErrorMessageKey("busy", true)).toBe("record.deviceError.busy.mic");
  });
});
