/**
 * A quick action on a list row (People's "want to meet"), with its failure
 * reported instead of swallowed (audit KIMIK31 W-17).
 *
 * The list's toggle caught every rejection and returned the unchanged settings,
 * including the protective SettingsUnreadableError that refuses to save over
 * notes it could not read. The tap looked ignored, and the user could not tell a
 * relay, a signer or that guard apart. The person's own page reported the same
 * failures; the list now does too, and keeps the state it had.
 */
export async function runRowAction<T>(
  run: () => Promise<T>,
  unchanged: T,
  onError: (error: unknown) => void,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    onError(error);
    return unchanged;
  }
}
