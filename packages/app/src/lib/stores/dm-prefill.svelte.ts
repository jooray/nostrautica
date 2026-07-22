/**
 * Transient one-shot DM composer prefill (SPECIFICATION §9.3 "Introduce us"). The
 * Matches screen sets a suggested opening line (a match icebreaker or the host-voice
 * reasoning) keyed by the peer's hex pubkey, then navigates to the DM composer,
 * which consumes it once to seed — but never sends — the draft. The user always
 * edits before sending; consuming clears it so a later manual visit starts blank.
 */
const drafts = new Map<string, string>();

export const dmPrefill = {
  /** Stage a prefill for a peer (hex pubkey). Overwrites any prior staged draft. */
  set(peerPubkey: string, text: string) {
    drafts.set(peerPubkey, text);
  },
  /** Take and clear the staged prefill for a peer, or undefined when none. */
  take(peerPubkey: string): string | undefined {
    const t = drafts.get(peerPubkey);
    drafts.delete(peerPubkey);
    return t;
  },
};
