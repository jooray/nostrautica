/** @module @category Utilities */
/** The cardinality rule for a required tag: exactly one value, or a non-empty deduplicated list. */
export type TagCardinality = "singleton" | "list";
/**
 * The #236 wire-boundary tag-cardinality table (`refs/marmot/transports/nostr.md`),
 * encoded as `(kind, tagName) -> "singleton" | "list"` data (D-10/D-11).
 *
 * This table is descriptive only — it does not itself validate anything; use
 * {@link getSingletonTagValue}/{@link getListTag} at each required-tag read site.
 */
export declare const TAG_CARDINALITY: Record<number, Record<string, TagCardinality>>;
/**
 * Strictly reads a required singleton tag: returns the value only when
 * exactly one tag named `name` exists on the event and it has exactly one
 * value slot. Rejects (returns `undefined`) when the tag is absent,
 * repeated, has no value, has extra values, or the value is empty (D-10/D-11).
 *
 * Never throws — malformed input is a typed reject, not an exception.
 *
 * Generic over any tagged event shape (mirrors `getTagValue`'s constraint) so
 * it works for both signed {@link NostrEvent}s (445, 1059) and unsigned
 * rumors (444 welcome), which carry no `sig`/`id`.
 *
 * @param event - The Nostr event (or rumor) to read the tag from
 * @param name - The tag name to look up
 * @returns The tag's single value, or `undefined` if the cardinality rule is violated
 */
export declare function getSingletonTagValue<T extends {
    tags: string[][];
}>(event: T, name: string): string | undefined;
/**
 * Strictly reads a required list tag: returns all values only when exactly
 * one tag named `name` exists on the event, it has at least one value, and
 * none of the values are empty or duplicated. Rejects (returns `undefined`)
 * when the tag is absent, repeated, empty, or contains duplicate values
 * (D-10/D-11).
 *
 * Never throws — malformed input is a typed reject, not an exception.
 *
 * Generic over any tagged event shape (mirrors `getTagValue`'s constraint) so
 * it works for both signed {@link NostrEvent}s (445, 1059) and unsigned
 * rumors (444 welcome), which carry no `sig`/`id`.
 *
 * @param event - The Nostr event (or rumor) to read the tag from
 * @param name - The tag name to look up
 * @returns The tag's values, or `undefined` if the cardinality rule is violated
 */
export declare function getListTag<T extends {
    tags: string[][];
}>(event: T, name: string): string[] | undefined;
