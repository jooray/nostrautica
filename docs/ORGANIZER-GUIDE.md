# Nostrautica — Event Organizer Guide

<!-- TODO(e2e): This is a skeleton produced ahead of testing. While running
docs/E2E-TESTING-GUIDE.md: replace every placeholder image, rewrite steps to
match the real UI, fill the FAQ with real friction, and remove all TODO
markers. Voice: the reader is an event organizer with light technical
comfort — explain *why* as well as *how*, but keep steps short. -->

Nostrautica is an event app built around one idea: **the point of your event
is who meets whom**. Attendees record short intro videos; an optional AI
coordinator analyzes them and tells every attendee who they should talk to
and why. This guide takes you from nothing to a running event.

## What you'll do

1. Create your identity (once).
2. Create the event.
3. Share the event — open link, invite codes, or both.
4. Approve attendees (or let invite codes auto-approve them).
5. Optionally attach an AI coordinator for matchmaking.
6. Run the event: watch the roster, manage people.

Everything runs in your browser. There is no server to set up — the app
stores event data, encrypted, on the open Nostr network. Your browser holds
the event's keys, so **use one browser you'll keep** (and back up your
identity when prompted).

## 1. Create your identity

Open the app and create an identity (or sign in with an existing Nostr
account if you have one — Nostrautica accounts *are* Nostr accounts).

When your identity is created you'll be shown a **backup card**. Do it now:
copy the secret key somewhere safe (password manager). Anyone with that key
*is* you; without it, a lost browser profile means a lost event.

![Key backup card](images/participant/03-backup.png)
<!-- TODO(e2e): screenshot participant/03-backup -->

## 2. Create the event

Choose “Create an event” and fill in the form:

![Event creation form](images/organizer/01-create-form.png)
<!-- TODO(e2e): screenshot organizer/01-create-form -->

- **Title, summary, dates, location** — shown publicly to anyone with the link.
- **Images** — an icon and a banner; optional, a generated design is used otherwise.
- **Intro video length** — the per-attendee cap in seconds (default is fine).
- **Approval mode** — how people get in:
  - *Manual review*: every request waits for your approval.
  - *Invite codes only*: an invite link gets you in automatically; no other way in.
  - *Invite + manual*: invite links auto-approve; people without a code wait
    for you. **Recommended for most events.**
- **AI matchmaking** — turn on if you plan to attach a coordinator (§5); you
  can attach it later, but leave the setting on.

After creating you'll get a **shareable link** for the event page.

![Event created — share link](images/organizer/02-created.png)
<!-- TODO(e2e): screenshot organizer/02-created -->

## 3. Share the event

From the admin screen you have two kinds of links:

- **The open event link** — anyone can view the public event page and request
  to join. Put it on your website or socials.
- **Invite codes** — single-use links that auto-approve the holder (when a
  coordinator is attached). Generate a batch, send one per person, or print
  the QR codes. The code lives only in the link — treat each like a ticket.

![Invite codes](images/organizer/04-invites.png)
<!-- TODO(e2e): screenshot organizer/04-invites -->

## 4. Approve attendees

The admin screen lists pending join requests — name, note, skills, and
whether they used an invite.

![Pending requests](images/organizer/06-pending.png)
<!-- TODO(e2e): screenshot organizer/06-pending -->

Approve the ones you want in; ignore or leave the rest. Approved attendees
get access within seconds — the encrypted roster, other people's intro
videos, and (with a coordinator) their matches.

![Approved attendees](images/organizer/07-approved.png)
<!-- TODO(e2e): screenshot organizer/07-approved -->

### Removing someone

Revoking an attendee cuts their access to everything published *from now
on* — the event keys are rotated for everyone else automatically. What they
already saw can't be unseen; revoke early if in doubt.

![Revoke confirmation](images/organizer/08-revoke.png)
<!-- TODO(e2e): screenshot organizer/08-revoke -->

## 5. Attach the AI coordinator (matchmaking)

The coordinator is a small service that transcribes intro videos, builds a
profile of each attendee, and computes who should meet whom. Without it, the
event still fully works — roster, videos, follows — there are just no
automatic matches and no invite auto-approval.

You (or whoever runs your infrastructure) start the coordinator and it gives
you its **public key (npub…)**. Paste that into the admin screen's
coordinator section.

![Coordinator attached](images/organizer/05-coordinator.png)
<!-- TODO(e2e): screenshot organizer/05-coordinator -->

<!-- TODO(e2e): link the coordinator operator setup (docker image, config,
API key) — one sentence + pointer to the repo README, not a full ops guide. -->

The coordinator only ever sees event content — it cannot act as the event or
change who's approved beyond the rules you set.

## 6. During the event

- **Roster fills in live** — approved attendees appear as they join and their
  match lists refresh as new intros are processed.
- **Recompute matches** — after a burst of new attendees you can trigger a
  full recompute from the admin screen.
- **Co-organizers** — add another person's npub to give them full organizer
  access from their own device. Also your safety net if your browser dies.
  <!-- TODO(e2e): confirm exact co-organizer behavior observed -->
- **Encourage intros early.** Matches only exist for people who recorded an
  intro — the single best thing you can do for match quality is get everyone
  to record before the event starts.

## Troubleshooting & FAQ

<!-- TODO(e2e): fill from real friction found during the test run. Seed
questions below — keep the ones that proved real, add what you hit. -->

- **A join request never showed up.** …
- **An invite link didn't auto-approve.** (Is a coordinator attached and running?) …
- **I opened the event on another device and there's no admin button.** (Organizer
  keys live in the browser that created the event — add yourself as
  co-organizer from the original device, or restore your identity backup.) …
- **How do I project the match board / roster at the venue?** …
- **What do attendees see before they're approved?** Only the public event
  page — title, description, dates. Videos, roster, and matches are encrypted
  to approved attendees.
