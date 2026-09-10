# Blind judging pack

240 items, 0 ungraded.
Model identity is not in this file. Grade each item 1-5 and write
`judging/grades.json` as `{ "<id>": { "score": n, "flags": [...], "note": "..." } }`.

## Rubric

**reasoning** — shown to `writtenFor` about `about`, 1-2 sentences, host voice.
  5 grounded in BOTH profiles, names a concrete thing to talk about, second person, no analytics
  3 accurate but generic, or one-sided, or slightly analytical
  1 invented facts, scoresplaining ("high complementarity"), or unusable as shown

**icebreaker** — a message `writtenFor` SENDS to `about`; first one is pasted into a DM as-is.
  5 sendable verbatim, concrete, correct ownership ("my" = writtenFor, "your" = about), natural in `lang`
  3 sendable but bland, or awkward phrasing in `lang`
  1 a briefing about the two of them, wrong ownership, or something no one would send

Flags (optional, free-form array): `invented`, `scoresplain`, `briefing`, `ownership`,
`generic`, `awkward-lang`, `unsendable`.
