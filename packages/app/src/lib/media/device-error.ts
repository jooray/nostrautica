/**
 * Classify a getUserMedia failure into a distinct recovery path (audit §7.4.10).
 * A single "couldn't access camera" message leaves the user guessing; the browser
 * actually tells us WHICH failure it is via the DOMException name, so we map it to
 * a specific cause the UI can give tailored recovery advice for. Pure + tested.
 */

export type DeviceErrorKind =
  | "denied" // permission refused / dismissed
  | "absent" // no such device present
  | "busy" // device held by another app/tab
  | "unsupported" // no mediaDevices API / constraints unsatisfiable / insecure context
  | "unknown";

/** Map a getUserMedia rejection to a recovery category. */
export function classifyDeviceError(err: unknown): DeviceErrorKind {
  // No API at all (old browser, or a non-secure context where it's undefined).
  if (err instanceof TypeError) return "unsupported";
  const name =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError": // legacy
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError": // legacy
      return "absent";
    case "NotReadableError":
    case "TrackStartError": // legacy
    case "AbortError":
      return "busy";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError": // legacy
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

/** The i18n message key carrying recovery guidance for a given kind. */
export function deviceErrorMessageKey(kind: DeviceErrorKind, audio: boolean): string {
  const medium = audio ? "mic" : "camera";
  return `record.deviceError.${kind}.${medium}`;
}
