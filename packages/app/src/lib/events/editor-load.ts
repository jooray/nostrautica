/**
 * Read a replaceable, whole-document authority event for an EDITOR (audit
 * KIMIK31 W-1).
 *
 * The event page (31608) and theme (31609) editors publish the WHOLE model back
 * on save. A read that failed and was turned into "nothing" therefore did not
 * just show an empty form: one press of Publish replaced the event's real menu,
 * sections, feeds or CSS with nothing, for every attendee. So an editor needs to
 * know whether what it is showing is the relay's answer or a stand-in, and the
 * stand-in is the cached copy (never an empty model) so the organizer can still
 * see what the event has.
 *
 * `definitive: true` means a relay answered: `value` is the authoritative model,
 * and `undefined` really means "this event has none". `definitive: false` means
 * the read failed: `value` is the last cached copy (or undefined if there is
 * none), and the caller must not let it be published.
 */
export type EditorRead<T> =
  | { definitive: true; value: T | undefined }
  | { definitive: false; value: T | undefined; error: unknown };

export async function readForEditing<T>(
  fetch: () => Promise<T | undefined>,
  cached: () => T | undefined,
): Promise<EditorRead<T>> {
  try {
    return { definitive: true, value: await fetch() };
  } catch (error) {
    return { definitive: false, value: cached(), error };
  }
}
