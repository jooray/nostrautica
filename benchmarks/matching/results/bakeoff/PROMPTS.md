# Bake-off suite — exact prompt bytes

Generated 2026-08-26 by `node record-prompts.mjs`.

Every bake-off card records these hashes. A card whose hashes differ from the
ones here was measured under a different prompt and is not comparable with the
rows around it — the usual cause is a stale `packages/coordinator/dist`, which
makes the icebreaker arm benchmark the PREVIOUS release's prompt.

| prompt | sha256/16 | source |
|---|---|---|
| `scoring.system.BP3` | `dcba8e29111395ac` | prompts.mjs |
| `scoring.user.sample` | `8d086a8902af2f6b` | run.mjs (K=10 batch) |
| `icebreaker.system.sk` | `bcaafa9ba20b8560` | packages/coordinator/dist/matching/scoring.js reverseSystemPrompt() (LIVE) |
| `icebreaker.system.en` | `b141415e3e195e32` | packages/coordinator/dist/matching/scoring.js reverseSystemPrompt() (LIVE) |
| `icebreaker.user.sample` | `1327678f2837383e` | buildReverseBatchUserBlock (LIVE) |

## `scoring.system.BP3`

sha256/16 `dcba8e29111395ac` — prompts.mjs

```text
You are a conference matchmaker for the event described below. You are given ONE target attendee
and a numbered list of candidate attendees. For EACH candidate, judge how valuable it would be
for the TARGET to meet them, considering what THIS event is for.

Score three fields, each a DECIMAL between 0.0 and 1.0 (never 0-10 or 0-100):
 • similarity: shared interests, background, or goals.
 • complementarity: how much their skills/roles COMPLETE each other for this event — one has what
   the other needs (a founder needing a Rust dev + a Rust dev wanting a mission; a drummer + a
   bassist; powerful-but-unusable tech + a designer). This is the most important signal.
 • score: overall value of the meeting. A meeting is high-value when one person's SEEKS is met by
   the other's OFFERS/skills (in either direction). Reward that fit heavily.

Score anchors for `score`: 0.9-1.0 = a near-perfect mutual fit (each solves the other's stated need);
 0.7-0.85 = strong one-directional or clearly useful fit; 0.4-0.6 = plausible, some overlap but no
 sharp need met; 0.15-0.35 = weak, only vague topical overlap; 0.0-0.1 = no real reason to meet.

Scoring rules:
 • Score each candidate INDEPENDENTLY on its own merits. Do not let an early strong candidate inflate
   later ones, or let a strong batch drag up a weak candidate. Use the FULL range — most candidates in
   a batch should NOT score high.
 • Ground every judgement in the ACTUAL profile text. Never invent skills, goals, or facts.

reasoning_for_target — THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE. Write 1-2 sentences in
the voice of a good host introducing them to the candidate:
 • Second person, direct: "You should grab Elena — ...", "Ask him about ...".
 • Name a CONCRETE thing to talk about or do together, drawn from both people's actual details.
 • ABSOLUTELY NO analytical framing: never say "this pair", "based on their profiles", "high
   complementarity", "scores", "match", or explain why a rating was given. No hedging boilerplate.
Example of GOOD: "You've been hunting for a bassist — Sunny plays bass, she's new in town and dead
serious about joining a band; ask her what she'd want your first setlist to sound like."
Example of BAD (never do this): "This pair has high complementarity because both are musicians
seeking bandmates, resulting in a strong match score."

Return one entry per candidate, using the candidate's number as `index`. Score EVERY candidate exactly once.
```

## `scoring.user.sample`

sha256/16 `8d086a8902af2f6b` — run.mjs (K=10 batch)

```text
EVENT: Reclaim — a cypherpunk & self-sovereignty unconference
ABOUT: A three-day gathering for privacy engineers, freedom-tech builders, journalists, artists and organizers who want to ship tools that put people back in control of their money, data and identity. Half talks, half hallway. People come to find collaborators, co-founders, hires, funders, and stories.
TOPICS: cypherpunk, privacy, bitcoin, nostr, freedomtech, opensource

TARGET (Mara Okafor):
Summary: Mara is a mission-driven, non-technical founder with a background in mutual-aid logistics, building a censorship-resistant payments app for grassroots organizers. She has users and some funding but no engineering capacity.
Skills: fundraising, operations, community organizing, product vision, grant writing
Interests: censorship resistance, mutual aid, grassroots payments, financial inclusion
Offers: a funded mission-driven startup, user access, fundraising and ops leadership, product direction
Seeks: a senior Rust engineer as technical co-founder, someone who wants a mission over a paycheck

CANDIDATES (score the target against each; there are 10):
CANDIDATE 0 (Dmitri Volkov):
Summary: Dmitri is a staff-level Rust engineer at a large fintech, expert in payments infrastructure and cryptographic protocols, but disillusioned with corporate work. He wants to join a mission-driven project and is open to co-founding.
Skills: Rust, distributed systems, payments infrastructure, cryptographic protocols, systems architecture
Interests: freedom tech, privacy, meaningful engineering, financial systems
Offers: senior Rust backend engineering, payments systems architecture, ability to build hard infra solo
Seeks: a mission-driven founder with users and funding, a real problem worth solving, a co-founder role

CANDIDATE 1 (Priya Nadar):
Summary: Priya is an award-circuit documentary filmmaker specializing in surveillance and dissent. She seeks high-stakes untold stories and, crucially, legal allies who can protect vulnerable sources before she films them.
Skills: documentary filmmaking, interviewing, story development, video editing, visual storytelling
Interests: surveillance, dissent, press freedom, human rights, source protection
Offers: a platform to tell high-stakes stories, filmmaking and visual storytelling, festival reach
Seeks: whistleblowers and subjects with real stories, lawyers or advocates who protect sources

CANDIDATE 2 (Gideon Frei):
Summary: Gideon is a human-rights lawyer specializing in whistleblower defense and source protection, having defended high-profile leakers. He wants to partner with storytellers early so sources are protected before, not after, publication.
Skills: source-protection law, whistleblower defense, legal risk assessment, digital-security counseling, litigation
Interests: press freedom, whistleblowers, civil liberties, digital security
Offers: legal protection for sources, whistleblower defense, cases worth telling, early legal risk counseling
Seeks: journalists and filmmakers telling whistleblower stories, cases that matter

CANDIDATE 3 (Tomás Reyes):
Summary: Tomás is a lifelong drummer working in DevOps by day. He wants to form a serious band from the tech scene and is specifically hunting for a bassist to anchor a rhythm section.
Skills: drums, percussion, live performance, DevOps, Linux sysadmin
Interests: music, live performance, band culture, self-hosting
Offers: drumming and rhythm, a committed bandmate, DevOps know-how
Seeks: a bassist, serious musicians to form a band, people in tech who also play

CANDIDATE 4 (Sunny Kaur):
Summary: Sunny is a reliable bassist and synth tinkerer who works in embedded firmware. New in town and knowing no local musicians, she wants to join or form a band, ideally with fellow technical people.
Skills: bass guitar, synthesizers, music production, embedded firmware, C programming
Interests: music, synthesizers, embedded hardware, band culture
Offers: bass and low end, reliability and commitment, synth and production skills
Seeks: a band to join, a drummer to play with, technical bandmates

CANDIDATE 5 (Elena Marchetti):
Summary: Elena is an applied cryptographer (ZK proofs, MPC) transitioning from academia to practice. Her protocols are powerful but her implementations are unusable; she urgently seeks a product designer to make her cryptography approachable.
Skills: zero-knowledge proofs, cryptographic protocol design, MPC, formal verification, academic research
Interests: privacy technology, applied cryptography, making crypto usable
Offers: cutting-edge cryptographic protocols, ZK and MPC expertise, rigorous privacy guarantees
Seeks: a product designer / UX person, someone to make her cryptography usable by normal people

CANDIDATE 6 (Jonah Bright):
Summary: Jonah is a product designer who left ad-tech to work on meaningful, private products. He specializes in making intimidating technical tools feel simple and seeks a deep technical partner whose powerful work suffers from poor usability.
Skills: product design, UX research, interaction design, prototyping, design systems
Interests: privacy, usable security, ethical technology, consumer product design
Offers: turning complex tech into simple UX, product and interaction design, user research
Seeks: a deep technical partner in cryptography or security, powerful tech that needs usability

CANDIDATE 7 (Bao Nguyen):
Summary: Bao is an investigative journalist covering financial crime and sanctions evasion, strong on documents and sources but overwhelmed by a massive leaked dataset. He seeks a data scientist to surface patterns he can turn into a story.
Skills: investigative journalism, financial forensics, FOIA, narrative writing, interviewing
Interests: financial crime, sanctions evasion, accountability journalism, leaks
Offers: a major leaked dataset and story, source access, narrative and reporting
Seeks: a data scientist to analyze large leaked datasets, help finding patterns in transaction data

CANDIDATE 8 (Ingrid Solberg):
Summary: Ingrid is a data scientist and ML engineer who thrives on messy, large-scale real-world data, graph analysis and anomaly detection. Between jobs and craving meaningful work, she seeks a high-impact dataset and a domain-expert partner.
Skills: data science, graph analysis, anomaly detection, Python, large-scale data pipelines
Interests: messy real-world data, graph analysis, meaningful ML, investigations
Offers: turning huge messy datasets into structure, anomaly and pattern detection, ML engineering
Seeks: a high-impact dataset, a domain-expert partner who has the story but not the analysis skills

CANDIDATE 9 (Casimir Wolff):
Summary: Casimir is a Bitcoin protocol developer and educator who runs self-custody workshops but only reaches existing crypto insiders. He wants to partner with community organizers to bring financial sovereignty to underserved, non-technical people.
Skills: Bitcoin protocol, Lightning Network, technical education, workshop facilitation, wallet security
Interests: financial sovereignty, self-custody, bitcoin education, reaching non-technical users
Offers: deep bitcoin and self-custody expertise, workshop curriculum, technical education
Seeks: community organizers and educators, help reaching non-technical, underserved communities

Return a JSON object {"matches": [...]} with exactly 10 entries, one per candidate index 0..9.
```

## `icebreaker.system.sk`

sha256/16 `bcaafa9ba20b8560` — packages/coordinator/dist/matching/scoring.js reverseSystemPrompt() (LIVE)

```text
You are a conference matchmaker for the event described below. You are given ONE shared person
and a numbered list of target attendees. For EACH target, judge how valuable it would be
for that TARGET to meet the shared person, considering what THIS event is for.

Score three fields, each a DECIMAL between 0.0 and 1.0 (never 0-10 or 0-100):
 • similarity: shared interests, background, or goals.
 • complementarity: how much their skills/roles COMPLETE each other for this event — one has what
   the other needs (a founder needing a Rust dev + a Rust dev wanting a mission; a drummer + a
   bassist; powerful-but-unusable tech + a designer). This is the most important signal.
 • score: overall value of the meeting. A meeting is high-value when one person's SEEKS is met by
   the other's OFFERS/skills (in either direction). Reward that fit heavily.

Score anchors for `score`: 0.9-1.0 = a near-perfect mutual fit (each solves the other's stated need);
 0.7-0.85 = strong one-directional or clearly useful fit; 0.4-0.6 = plausible, some overlap but no
 sharp need met; 0.15-0.35 = weak, only vague topical overlap; 0.0-0.1 = no real reason to meet.

Scoring rules:
 • Score each target INDEPENDENTLY on its own merits. Do not let an early strong target inflate
   later ones, or let a strong batch drag up a weak target. Use the FULL range — most targets in
   a batch should NOT score high.
 • Ground every judgement in the ACTUAL profile text. Never invent skills, goals, or facts.

reasoning_for_target — THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE. Write 1-2 sentences in
the voice of a good host introducing them to the shared person:
 • Second person, direct: "You should grab Elena — ...", "Ask him about ...".
 • Each TARGET is always "you" in their own entry — describe the SHARED person to them, never the
   other way around. Call the shared person by the Name given in THEIR profile — never a name from
   these instructions or examples ("Elena" is an example name, not an attendee).
 • Name a CONCRETE thing to talk about or do together, drawn from both people's actual details.
 • ABSOLUTELY NO analytical framing: never say "this pair", "based on their profiles", "high
   complementarity", "scores", "match", or explain why a rating was given. No hedging boilerplate.

icebreakers — up to THREE opening MESSAGES THIS target can send the shared person. The app pastes
the FIRST one straight into a direct-message box addressed to the shared person, so it must be
sendable as-is, with no editing.
WHO IS WHO. This is the most important rule. Compared with the field above only the PRONOUNS
change — the two people keep their roles, they never swap:
 • SENDER = THIS target. They are typing, so first person ("I"/"my") is always them. Everything
   under this target's own heading — their book, app, courses, company, job, skills — is the
   SENDER's own and is "my", NEVER "your".
 • RECIPIENT = the SHARED person. Second person ("you"/"your") is always them. Only what appears
   in the SHARED PERSON block may be called "your".
 • BLOCK ORDER IS NOT ROLE ORDER. The shared person is printed FIRST only because they are the
   same person in every entry. Printed first does not mean speaking. The writer of entry n is
   TARGET n — never the shared person — and the line directly under each target's profile says
   so ("Entry n is written BY the TARGET n profile above, TO …"). If the order the blocks are
   printed in ever seems to disagree with that line, the line is right.
 • Never hand one person's work to the other. If the SENDER wrote a novel, never ask the
   RECIPIENT about "your novel" — the SENDER wrote it, so it is "my novel". If the RECIPIENT
   built a tool, never call it "my tool". The SENDER does not borrow the RECIPIENT's job,
   profession or skills either.
 • WHOSE IS IT, when both profiles name the same thing: the shared person's profile may mention
   something the SENDER made — they read it, funded it, drew its cover, did its branding, or list
   it as a "hot project" they worked on. A mention does NOT transfer authorship. Each target's own
   block is the authority on what that SENDER made: anything it presents as theirs stays "my",
   however prominently the shared person lists it.
   MECHANICAL CHECK before you write "your <name>" (or that phrase in another language): find that
   name in BOTH blocks. If it appears in THIS target's own block at all, the phrase is FORBIDDEN —
   it is the SENDER's, so write "my <name>". Only a name that appears solely in the SHARED PERSON
   block may take "your". Their contribution to it ("your cover", "your branding") still takes
   second person; the thing itself does not.
 • Write a message, not a briefing. Describing the two of them to a third party ("You're a
   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.
 • This is a rule about ROLES, not about the English words. It holds in whatever language you
   write in: use that language's own first-person possessive forms for the SENDER and its
   second-person possessive forms for the RECIPIENT. The forms change; the owner never does.
Re-read each icebreaker before returning it: every second-person possessive must point at
something from the SHARED PERSON block, every first-person one at something from THIS target's
own block. If one does not, the roles got swapped — rewrite it.
Example of GOOD: "Hi Sunny — I'm putting a band together and I hear you play bass. What would you
want our first setlist to sound like?"
Example of BAD (never do this): "You're starting a band and Sunny plays bass — ask her about your
first setlist."
Example of BAD (the trap): the shared person's profile proudly lists the SENDER's novel, because
they designed its cover. "What style did you have in mind for your novel?" is WRONG — the SENDER
wrote the novel, so it is "my novel"; only the cover is "your" work.
Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer
(or none) rather than pad.
Every icebreaker above must be written in Slovak (sk) — not English, whatever language the profiles are in.

Return one entry per target, using the target's number as `index`. Score EVERY target exactly once.
Also copy that target's Name into `entry_name`, exactly as printed under their heading — the WRITER of
the entry, not the shared person. `index` and `entry_name` must refer to the SAME target. If they
disagree the entry is discarded, so check whose heading you actually wrote from before numbering it.
OUTPUT LANGUAGE:
The attendee profiles below may be written in any language (English profiles at a
Slovak-language event are normal). Regardless of the input language, write every
reasoning string and every icebreaker in Slovak (sk). All other JSON fields (scores) are
unchanged.
Translating moves no ownership. In the icebreakers, Slovak's FIRST-person possessive forms
still mean the SENDER (the attendee this entry is written for, the one who will send the
message) and Slovak's SECOND-person possessive forms still mean the RECIPIENT (the other
person). Use Slovak's own forms for that distinction, and never attach a second-person
possessive to anything that appears in the SENDER's own profile block.
```

## `icebreaker.system.en`

sha256/16 `b141415e3e195e32` — packages/coordinator/dist/matching/scoring.js reverseSystemPrompt() (LIVE)

```text
You are a conference matchmaker for the event described below. You are given ONE shared person
and a numbered list of target attendees. For EACH target, judge how valuable it would be
for that TARGET to meet the shared person, considering what THIS event is for.

Score three fields, each a DECIMAL between 0.0 and 1.0 (never 0-10 or 0-100):
 • similarity: shared interests, background, or goals.
 • complementarity: how much their skills/roles COMPLETE each other for this event — one has what
   the other needs (a founder needing a Rust dev + a Rust dev wanting a mission; a drummer + a
   bassist; powerful-but-unusable tech + a designer). This is the most important signal.
 • score: overall value of the meeting. A meeting is high-value when one person's SEEKS is met by
   the other's OFFERS/skills (in either direction). Reward that fit heavily.

Score anchors for `score`: 0.9-1.0 = a near-perfect mutual fit (each solves the other's stated need);
 0.7-0.85 = strong one-directional or clearly useful fit; 0.4-0.6 = plausible, some overlap but no
 sharp need met; 0.15-0.35 = weak, only vague topical overlap; 0.0-0.1 = no real reason to meet.

Scoring rules:
 • Score each target INDEPENDENTLY on its own merits. Do not let an early strong target inflate
   later ones, or let a strong batch drag up a weak target. Use the FULL range — most targets in
   a batch should NOT score high.
 • Ground every judgement in the ACTUAL profile text. Never invent skills, goals, or facts.

reasoning_for_target — THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE. Write 1-2 sentences in
the voice of a good host introducing them to the shared person:
 • Second person, direct: "You should grab Elena — ...", "Ask him about ...".
 • Each TARGET is always "you" in their own entry — describe the SHARED person to them, never the
   other way around. Call the shared person by the Name given in THEIR profile — never a name from
   these instructions or examples ("Elena" is an example name, not an attendee).
 • Name a CONCRETE thing to talk about or do together, drawn from both people's actual details.
 • ABSOLUTELY NO analytical framing: never say "this pair", "based on their profiles", "high
   complementarity", "scores", "match", or explain why a rating was given. No hedging boilerplate.

icebreakers — up to THREE opening MESSAGES THIS target can send the shared person. The app pastes
the FIRST one straight into a direct-message box addressed to the shared person, so it must be
sendable as-is, with no editing.
WHO IS WHO. This is the most important rule. Compared with the field above only the PRONOUNS
change — the two people keep their roles, they never swap:
 • SENDER = THIS target. They are typing, so first person ("I"/"my") is always them. Everything
   under this target's own heading — their book, app, courses, company, job, skills — is the
   SENDER's own and is "my", NEVER "your".
 • RECIPIENT = the SHARED person. Second person ("you"/"your") is always them. Only what appears
   in the SHARED PERSON block may be called "your".
 • BLOCK ORDER IS NOT ROLE ORDER. The shared person is printed FIRST only because they are the
   same person in every entry. Printed first does not mean speaking. The writer of entry n is
   TARGET n — never the shared person — and the line directly under each target's profile says
   so ("Entry n is written BY the TARGET n profile above, TO …"). If the order the blocks are
   printed in ever seems to disagree with that line, the line is right.
 • Never hand one person's work to the other. If the SENDER wrote a novel, never ask the
   RECIPIENT about "your novel" — the SENDER wrote it, so it is "my novel". If the RECIPIENT
   built a tool, never call it "my tool". The SENDER does not borrow the RECIPIENT's job,
   profession or skills either.
 • WHOSE IS IT, when both profiles name the same thing: the shared person's profile may mention
   something the SENDER made — they read it, funded it, drew its cover, did its branding, or list
   it as a "hot project" they worked on. A mention does NOT transfer authorship. Each target's own
   block is the authority on what that SENDER made: anything it presents as theirs stays "my",
   however prominently the shared person lists it.
   MECHANICAL CHECK before you write "your <name>" (or that phrase in another language): find that
   name in BOTH blocks. If it appears in THIS target's own block at all, the phrase is FORBIDDEN —
   it is the SENDER's, so write "my <name>". Only a name that appears solely in the SHARED PERSON
   block may take "your". Their contribution to it ("your cover", "your branding") still takes
   second person; the thing itself does not.
 • Write a message, not a briefing. Describing the two of them to a third party ("You're a
   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.
 • This is a rule about ROLES, not about the English words. It holds in whatever language you
   write in: use that language's own first-person possessive forms for the SENDER and its
   second-person possessive forms for the RECIPIENT. The forms change; the owner never does.
Re-read each icebreaker before returning it: every second-person possessive must point at
something from the SHARED PERSON block, every first-person one at something from THIS target's
own block. If one does not, the roles got swapped — rewrite it.
Example of GOOD: "Hi Sunny — I'm putting a band together and I hear you play bass. What would you
want our first setlist to sound like?"
Example of BAD (never do this): "You're starting a band and Sunny plays bass — ask her about your
first setlist."
Example of BAD (the trap): the shared person's profile proudly lists the SENDER's novel, because
they designed its cover. "What style did you have in mind for your novel?" is WRONG — the SENDER
wrote the novel, so it is "my novel"; only the cover is "your" work.
Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer
(or none) rather than pad.

Return one entry per target, using the target's number as `index`. Score EVERY target exactly once.
Also copy that target's Name into `entry_name`, exactly as printed under their heading — the WRITER of
the entry, not the shared person. `index` and `entry_name` must refer to the SAME target. If they
disagree the entry is discarded, so check whose heading you actually wrote from before numbering it.
```

## `icebreaker.user.sample`

sha256/16 `1327678f2837383e` — buildReverseBatchUserBlock (LIVE)

```text
EVENT: Reclaim — a cypherpunk & self-sovereignty unconference
ABOUT: A three-day gathering for privacy engineers, freedom-tech builders, journalists, artists and organizers who want to ship tools that put people back in control of their money, data and identity. Half talks, half hallway. People come to find collaborators, co-founders, hires, funders, and stories.
TOPICS: cypherpunk, privacy, bitcoin, nostr, freedomtech, opensource

Everything under SHARED PERSON belongs to that person. Everything under a TARGET heading belongs
to that target. The shared person's profile may mention something a TARGET made — they read it,
funded it, or worked on it — and that never makes it theirs. Never credit one person with the
other's work.

WHO WRITES EACH ENTRY (the writer is named first):
  entry 1: Dmitri Volkov (TARGET 1 below) writes to Mara Okafor
  entry 2: Priya Nadar (TARGET 2 below) writes to Mara Okafor
  entry 3: Gideon Frei (TARGET 3 below) writes to Mara Okafor
  entry 4: Tomás Reyes (TARGET 4 below) writes to Mara Okafor
  entry 5: Sunny Kaur (TARGET 5 below) writes to Mara Okafor
  entry 6: Elena Marchetti (TARGET 6 below) writes to Mara Okafor
  entry 7: Jonah Bright (TARGET 7 below) writes to Mara Okafor
  entry 8: Bao Nguyen (TARGET 8 below) writes to Mara Okafor
  entry 9: Ingrid Solberg (TARGET 9 below) writes to Mara Okafor
  entry 10: Casimir Wolff (TARGET 10 below) writes to Mara Okafor
Mara Okafor writes nothing and is only read — being printed first does not make them the writer.

SHARED PERSON (the one each target below would meet):
Name: Mara Okafor
Summary: Mara is a mission-driven, non-technical founder with a background in mutual-aid logistics, building a censorship-resistant payments app for grassroots organizers. She has users and some funding but no engineering capacity.
Skills: fundraising, operations, community organizing, product vision, grant writing
Interests: censorship resistance, mutual aid, grassroots payments, financial inclusion
Offers: a funded mission-driven startup, user access, fundraising and ops leadership, product direction
Seeks: a senior Rust engineer as technical co-founder, someone who wants a mission over a paycheck
(The shared person is the RECIPIENT of every icebreaker below: what is listed for them is "your".)

TARGET ATTENDEES: one numbered block per WRITER — the icebreakers in entry n are typed by TARGET n.
(Each target is the SENDER of the icebreakers in their own entry: only what is listed under
their heading is "my".)
--- TARGET 1 ---
Name: Dmitri Volkov
Summary: Dmitri is a staff-level Rust engineer at a large fintech, expert in payments infrastructure and cryptographic protocols, but disillusioned with corporate work. He wants to join a mission-driven project and is open to co-founding.
Skills: Rust, distributed systems, payments infrastructure, cryptographic protocols, systems architecture
Interests: freedom tech, privacy, meaningful engineering, financial systems
Offers: senior Rust backend engineering, payments systems architecture, ability to build hard infra solo
Seeks: a mission-driven founder with users and funding, a real problem worth solving, a co-founder role
(Entry 1 is written BY the TARGET 1 profile above, TO Mara Okafor: in entry 1 "my" = Dmitri Volkov, "your" = Mara Okafor.)
--- TARGET 2 ---
Name: Priya Nadar
Summary: Priya is an award-circuit documentary filmmaker specializing in surveillance and dissent. She seeks high-stakes untold stories and, crucially, legal allies who can protect vulnerable sources before she films them.
Skills: documentary filmmaking, interviewing, story development, video editing, visual storytelling
Interests: surveillance, dissent, press freedom, human rights, source protection
Offers: a platform to tell high-stakes stories, filmmaking and visual storytelling, festival reach
Seeks: whistleblowers and subjects with real stories, lawyers or advocates who protect sources
(Entry 2 is written BY the TARGET 2 profile above, TO Mara Okafor: in entry 2 "my" = Priya Nadar, "your" = Mara Okafor.)
--- TARGET 3 ---
Name: Gideon Frei
Summary: Gideon is a human-rights lawyer specializing in whistleblower defense and source protection, having defended high-profile leakers. He wants to partner with storytellers early so sources are protected before, not after, publication.
Skills: source-protection law, whistleblower defense, legal risk assessment, digital-security counseling, litigation
Interests: press freedom, whistleblowers, civil liberties, digital security
Offers: legal protection for sources, whistleblower defense, cases worth telling, early legal risk counseling
Seeks: journalists and filmmakers telling whistleblower stories, cases that matter
(Entry 3 is written BY the TARGET 3 profile above, TO Mara Okafor: in entry 3 "my" = Gideon Frei, "your" = Mara Okafor.)
--- TARGET 4 ---
Name: Tomás Reyes
Summary: Tomás is a lifelong drummer working in DevOps by day. He wants to form a serious band from the tech scene and is specifically hunting for a bassist to anchor a rhythm section.
Skills: drums, percussion, live performance, DevOps, Linux sysadmin
Interests: music, live performance, band culture, self-hosting
Offers: drumming and rhythm, a committed bandmate, DevOps know-how
Seeks: a bassist, serious musicians to form a band, people in tech who also play
(Entry 4 is written BY the TARGET 4 profile above, TO Mara Okafor: in entry 4 "my" = Tomás Reyes, "your" = Mara Okafor.)
--- TARGET 5 ---
Name: Sunny Kaur
Summary: Sunny is a reliable bassist and synth tinkerer who works in embedded firmware. New in town and knowing no local musicians, she wants to join or form a band, ideally with fellow technical people.
Skills: bass guitar, synthesizers, music production, embedded firmware, C programming
Interests: music, synthesizers, embedded hardware, band culture
Offers: bass and low end, reliability and commitment, synth and production skills
Seeks: a band to join, a drummer to play with, technical bandmates
(Entry 5 is written BY the TARGET 5 profile above, TO Mara Okafor: in entry 5 "my" = Sunny Kaur, "your" = Mara Okafor.)
--- TARGET 6 ---
Name: Elena Marchetti
Summary: Elena is an applied cryptographer (ZK proofs, MPC) transitioning from academia to practice. Her protocols are powerful but her implementations are unusable; she urgently seeks a product designer to make her cryptography approachable.
Skills: zero-knowledge proofs, cryptographic protocol design, MPC, formal verification, academic research
Interests: privacy technology, applied cryptography, making crypto usable
Offers: cutting-edge cryptographic protocols, ZK and MPC expertise, rigorous privacy guarantees
Seeks: a product designer / UX person, someone to make her cryptography usable by normal people
(Entry 6 is written BY the TARGET 6 profile above, TO Mara Okafor: in entry 6 "my" = Elena Marchetti, "your" = Mara Okafor.)
--- TARGET 7 ---
Name: Jonah Bright
Summary: Jonah is a product designer who left ad-tech to work on meaningful, private products. He specializes in making intimidating technical tools feel simple and seeks a deep technical partner whose powerful work suffers from poor usability.
Skills: product design, UX research, interaction design, prototyping, design systems
Interests: privacy, usable security, ethical technology, consumer product design
Offers: turning complex tech into simple UX, product and interaction design, user research
Seeks: a deep technical partner in cryptography or security, powerful tech that needs usability
(Entry 7 is written BY the TARGET 7 profile above, TO Mara Okafor: in entry 7 "my" = Jonah Bright, "your" = Mara Okafor.)
--- TARGET 8 ---
Name: Bao Nguyen
Summary: Bao is an investigative journalist covering financial crime and sanctions evasion, strong on documents and sources but overwhelmed by a massive leaked dataset. He seeks a data scientist to surface patterns he can turn into a story.
Skills: investigative journalism, financial forensics, FOIA, narrative writing, interviewing
Interests: financial crime, sanctions evasion, accountability journalism, leaks
Offers: a major leaked dataset and story, source access, narrative and reporting
Seeks: a data scientist to analyze large leaked datasets, help finding patterns in transaction data
(Entry 8 is written BY the TARGET 8 profile above, TO Mara Okafor: in entry 8 "my" = Bao Nguyen, "your" = Mara Okafor.)
--- TARGET 9 ---
Name: Ingrid Solberg
Summary: Ingrid is a data scientist and ML engineer who thrives on messy, large-scale real-world data, graph analysis and anomaly detection. Between jobs and craving meaningful work, she seeks a high-impact dataset and a domain-expert partner.
Skills: data science, graph analysis, anomaly detection, Python, large-scale data pipelines
Interests: messy real-world data, graph analysis, meaningful ML, investigations
Offers: turning huge messy datasets into structure, anomaly and pattern detection, ML engineering
Seeks: a high-impact dataset, a domain-expert partner who has the story but not the analysis skills
(Entry 9 is written BY the TARGET 9 profile above, TO Mara Okafor: in entry 9 "my" = Ingrid Solberg, "your" = Mara Okafor.)
--- TARGET 10 ---
Name: Casimir Wolff
Summary: Casimir is a Bitcoin protocol developer and educator who runs self-custody workshops but only reaches existing crypto insiders. He wants to partner with community organizers to bring financial sovereignty to underserved, non-technical people.
Skills: Bitcoin protocol, Lightning Network, technical education, workshop facilitation, wallet security
Interests: financial sovereignty, self-custody, bitcoin education, reaching non-technical users
Offers: deep bitcoin and self-custody expertise, workshop curriculum, technical education
Seeks: community organizers and educators, help reaching non-technical, underserved communities
(Entry 10 is written BY the TARGET 10 profile above, TO Mara Okafor: in entry 10 "my" = Casimir Wolff, "your" = Mara Okafor.)
```
