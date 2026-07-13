# Nostrautica — Participant Guide

<!-- TODO(e2e): This is a skeleton produced ahead of testing. While running
docs/E2E-TESTING-GUIDE.md: replace every placeholder image, rewrite steps to
match the real UI, fill the FAQ with real friction, and remove all TODO
markers. Voice: the reader has NEVER heard of Nostr. No protocol jargon, no
"kind" numbers, no "relay" unless the UI itself says it. Analogies over
precision. Short sentences. Phone screenshots. -->

Someone invited you to an event that runs on Nostrautica. Here's the deal:
you record a short video introducing yourself, and before the event starts
the app tells you **exactly who there is worth meeting — and why**. No more
hoping you bump into the right person at the coffee machine.

Five minutes of setup, all on your phone.

![The app](images/participant/01-home.png)
<!-- TODO(e2e): screenshot participant/01-home -->

## 1. Open your invite link

Tap the link you were given. You'll see the event page — what it is, when,
where — and a button to join.

![Event page](images/participant/02-event-page.png)
<!-- TODO(e2e): screenshot participant/02-event-page -->

## 2. Join

Fill in how people should know you:

![Join form](images/participant/04-join-form.png)
<!-- TODO(e2e): screenshot participant/04-join-form -->

- **Photo and name** — how you'll appear to other attendees (these are
  public, like any social profile).
- **About you, your skills, what you're looking for** — this is what the
  matching runs on. Be concrete: “rust developer, looking for a co-founder”
  beats “tech enthusiast”. It's worth the extra minute.

No email, no password, no account signup. The app creates a portable
identity for you on the spot (more on that at the end — it's a nice bonus).

> **Already on Nostr?** Sign in with your existing key, extension, or remote
> signer instead — your profile carries over and your public posts make your
> matches better. The app never modifies your existing profile.
> ![Sign-in options](images/participant/07-signin-options.png)
> <!-- TODO(e2e): screenshot participant/07-signin-options -->

Depending on your link, you're either in immediately…

![You're in](images/participant/06-approved.png)
<!-- TODO(e2e): screenshot participant/06-approved -->

…or the organizer approves you shortly:

![Request sent](images/participant/05-request-sent.png)
<!-- TODO(e2e): screenshot participant/05-request-sent -->

### Save your key (30 seconds, actually do it)

After joining, the app shows a **backup card** with your secret key. Copy it
into your password manager. It's the only way back into your account if you
lose your phone — there's no “forgot password” email, because there's no
company holding your account.

![Backup card](images/participant/03-backup.png)
<!-- TODO(e2e): screenshot participant/03-backup -->

## 3. Record your intro

This is the important part — **no intro, no matches**. From the event page,
tap record, allow the camera, and talk for a minute: who you are, what
you're working on, what you're looking for. You can watch it back and
re-record until you're happy. Nobody outside this event's attendees can ever
see it.

![Recording](images/participant/09-record.png)
<!-- TODO(e2e): screenshot participant/09-record -->

## 4. See who's here

Once you're in, browse the attendee list. Tap anyone to see their intro
video, what they do, and what they're looking for.

![Attendees](images/participant/08-attendees.png)
<!-- TODO(e2e): screenshot participant/08-attendees -->

On a person's page you can also — privately, nobody else ever sees these —
star them as a favorite, mark “want to meet” or “met”, and keep notes
(“the drummer with the mesh-network startup”).

![A person's page](images/participant/10-attendee-detail.png)
<!-- TODO(e2e): screenshot participant/10-attendee-detail -->

## 5. Your matches

Shortly after you record your intro, check “people you should meet”: a
ranked list of attendees, each with a plain-language explanation of why you
two should talk — shared interests *and* complementary skills. The list
updates as more people join.

![Your matches](images/participant/11-matches.png)
<!-- TODO(e2e): screenshot participant/11-matches -->

At the event, work the list: find your top matches, mention the app told you
to. Best icebreaker there is.

## 6. Afterwards: your profile is yours to keep

Surprise: the account you just used is a **Nostr identity** — a login you
own, not tied to this app or any company. The people you followed at the
event, your profile, all of it works in a whole ecosystem of social apps
(Primal, Damus, Amethyst…). Open your profile page to grab your key and take
it anywhere.

![Your profile](images/participant/13-me.png)
<!-- TODO(e2e): screenshot participant/13-me -->

## Privacy, in one paragraph

Your name, photo and bio are public (that's your profile). Your intro video,
the attendee list, and your matches are **encrypted so only this event's
approved attendees can see them** — not the public, not people who weren't
let in. Your favorites and notes are encrypted so **only you** can see them.
The matching runs on an AI service chosen by the organizer, which reads
intros and profiles to write its recommendations.

## Troubleshooting

<!-- TODO(e2e): fill from real friction during the test run. Seeds: -->

- **My camera won't start.** (Browser permission prompt — check the address
  bar; try another browser.) …
- **I'm still “waiting for approval”.** (The organizer approves manually —
  give it a moment or find them.) …
- **I got a new phone / cleared my browser.** (Sign in with the secret key
  you backed up.) …
- **No matches are showing yet.** (Record your intro first; matches take a
  few minutes to compute and need enough other attendees.) …
