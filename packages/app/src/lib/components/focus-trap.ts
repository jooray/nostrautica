/**
 * Minimal focus trap for modal dialogs (audit §7.3.2). A Svelte `use:` action:
 * on mount it records the previously-focused element, moves focus into the modal
 * (first focusable, or the container itself), and confines Tab/Shift+Tab to the
 * modal's focusable set; on destroy it restores focus to where it was. Escape is
 * handled by the component (it needs to run the modal's own cancel path), so this
 * only owns focus containment + restore.
 */
const FOCUSABLE =
  'a[href],area[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),' +
  'textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Focusable descendants in DOM order, excluding hidden ones. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Given the current focused element and Shift state, compute the element Tab
 * should land on to wrap within `list`. Returns null when the browser's native
 * Tab order already stays inside (no wrap needed). Pure — unit-tested.
 */
export function nextTrapTarget(
  list: HTMLElement[],
  current: HTMLElement | null,
  shift: boolean,
): HTMLElement | null {
  if (list.length === 0) return null;
  const first = list[0];
  const last = list[list.length - 1];
  if (!shift && current === last) return first;
  if (shift && current === first) return last;
  // Focus outside the trapped set entirely → pull it back to an edge.
  if (current === null || !list.includes(current)) return shift ? last : first;
  return null;
}

export function focusTrap(node: HTMLElement) {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const list = focusableWithin(node);
    const target = nextTrapTarget(list, document.activeElement as HTMLElement | null, e.shiftKey);
    if (target) {
      e.preventDefault();
      target.focus();
    }
  }

  node.addEventListener("keydown", onKeydown);
  // Move focus in: first focusable, else the container (needs tabindex="-1").
  const initial = focusableWithin(node)[0] ?? node;
  queueMicrotask(() => initial.focus());

  return {
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      previouslyFocused?.focus?.();
    },
  };
}
