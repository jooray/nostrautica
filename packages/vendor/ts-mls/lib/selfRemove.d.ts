/**
 * The `self_remove` proposal type defined in the MLS extensions work
 * (draft-ietf-mls-extensions), value `0x000a`.
 *
 * A member uses it to propose their own removal. Unlike a `remove` proposal —
 * which a committer may not aim at their own leaf (RFC 9420 §12.2) — a
 * `self_remove` is committed by *another* member. Its body is empty: the leaving
 * member is identified by the proposal's MLS sender, so it MUST be committed by
 * reference (which preserves the original sender) and never inline.
 *
 * @public
 */
export declare const selfRemoveProposalType = 10;
