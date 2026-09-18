/**
 * Should a click inside a match entry open that person?
 *
 * A match entry is mostly reasoning: the identity line at the top is 41px of a
 * ~186px entry, so when only that line was clickable, the item somebody most
 * wants to open had a far smaller target than a plain roster row, whose whole
 * row is a button. It read from the outside as "the strong match doesn't open
 * and the one below it does" (reported 2026-09-13).
 *
 * The reasoning still has to be selectable — it is the text people copy into a
 * first message — so the entry is not wrapped in a button. This is the rule that
 * makes a plain click handler safe instead, and it lives here so it can be
 * tested without a browser.
 */
export function shouldOpenFromBody(
  target: Element | null,
  selectionCollapsed: boolean,
): boolean {
  // A click that landed on a control belongs to that control: the follow and
  // message buttons, the conversation-starters disclosure, a link.
  if (target?.closest("button, a, summary, details, input, textarea")) return false;
  // A click that ended a text selection was a drag, not a tap.
  if (!selectionCollapsed) return false;
  return true;
}
