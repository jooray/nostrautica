/**
 * Shared form-validation primitives (audit §7.3.7). Forms across the app hand-
 * rolled a single top-level error string with no field linkage, no summary, and
 * no focus management — a screen-reader user got "something's wrong" with no way
 * to find which field. This module is the pure core: components turn its output
 * into `aria-invalid` / `aria-describedby` wiring, an error summary, and
 * first-error focus.
 *
 * A field "check" is `{ id, message }` where `id` is the field's DOM id and
 * `message` is the error text (already localized by the caller) or `null` when
 * valid. Callers list checks in visual/DOM order; the first failing one is the
 * focus target.
 */

export interface FieldCheck {
  /** DOM id of the field this check applies to. */
  id: string;
  /** Localized error message, or null when the field is valid. */
  message: string | null;
}

export interface FieldError {
  id: string;
  message: string;
}

export interface ValidationResult {
  errors: FieldError[];
  /** True when every check passed. */
  ok: boolean;
  /** DOM id of the first failing field (focus + summary target), or undefined. */
  firstErrorId: string | undefined;
}

/** Reduce an ordered list of checks to the failing ones, preserving order. */
export function validate(checks: FieldCheck[]): ValidationResult {
  const errors: FieldError[] = [];
  for (const c of checks) {
    if (c.message !== null && c.message !== "") errors.push({ id: c.id, message: c.message });
  }
  return { errors, ok: errors.length === 0, firstErrorId: errors[0]?.id };
}

/** The id an error message element carries, derived from its field id. */
export function errorId(fieldId: string): string {
  return `${fieldId}-error`;
}

/**
 * `aria-describedby` value for a field: its error-message id when it has an
 * error (optionally combined with an existing hint id), else the hint id or
 * undefined. Keeps hint + error both announced without clobbering either.
 */
export function describedBy(
  fieldId: string,
  hasError: boolean,
  hintId?: string,
): string | undefined {
  const ids = [hintId, hasError ? errorId(fieldId) : undefined].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

/** True when a given field id is in the error set (drives `aria-invalid`). */
export function hasError(errors: FieldError[], fieldId: string): boolean {
  return errors.some((e) => e.id === fieldId);
}
