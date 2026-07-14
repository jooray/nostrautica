# Nostrautica — Participant Guide

Someone invited you to an event that runs on Nostrautica. Here's the deal:
you record a short video introducing yourself, and before the event starts
the app tells you **exactly who there is worth meeting — and why**. No more
hoping you bump into the right person at the coffee machine.

Five minutes of setup, all on your phone.

![The app](images/participant/01-home-light.png)

## 1. Open your invite link

Tap the link you were given. You'll see the event page — what it is, when,
where — and a button to join. If the organizer has posted any announcements,
they show up here too, under **Updates from the organizer**.

![Event page](images/participant/02-event-page-light.png)

## 2. Join

Tap **Join this event** and fill in how people should know you:

![Join form](images/participant/04-join-form-light.png)

- **Photo, name, and "About you"** — this is your public profile, like any
  social app. The form says so: *"Name, photo and bio are public — everything
  else stays inside the event."*
- **Skills** and **What are you looking for?** — this is what the matching runs
  on. Be concrete: "rust developer, looking for a co-founder" beats "tech
  enthusiast". It's worth the extra minute.
- There's a checkbox to **publish a public RSVP** if you want others to see
  you're attending. Leave it off to keep your attendance inside the event.

No email, no password, no signup. When you tap **Create identity & join**, the
app makes a portable identity for you on the spot (more on that at the end —
it's a nice bonus).

> **Already use one of these?** If you tap **Already on Nostr? Sign in**, you
> can sign in with your existing key, a browser extension, or a phone signer
> app (like Amber or Clave) instead. Your existing profile carries over and is
> shown read-only — the app never changes it — and only the event-specific
> fields (skills, looking-for) are yours to fill in.
>
> ![Sign-in options](images/participant/07-signin-options-light.png)

After you submit, one of two things happens depending on your link:

- **You're in right away** (invite links, when the organizer's matchmaking
  service is running) — you'll see a "You're in" screen with a button to see
  who's here:

  ![You're in](images/participant/06-approved-light.png)

- **The organizer approves you shortly** — you'll see a "waiting for approval"
  screen. You can close the app; you'll get in as soon as they approve.

  ![Request sent](images/participant/05-request-sent-light.png)

### Save your key (30 seconds — actually do it)

After joining, the app shows a **backup card** with your secret key. Tap **Copy
my secret key** and paste it into your password manager. It's the only way back
into your account if you lose your phone — there's no "forgot password" email,
because there's no company holding your account. ("More ways to back up" can
email you a recovery link or make a password-protected file.)

![Backup card](images/participant/03-backup-light.png)

## 3. Record your intro

This is the important part — **no intro, no matches**. From the event page, tap
**Record / update your intro**, tap **Enable camera**, then **● Record**. Talk
for up to a minute: who you are, what you're working on, what you're looking
for. Hit **■ Stop** (it also stops itself at the time limit), watch it back,
and tap **Use this** — or **Re-record** until you're happy. Nobody outside this
event's attendees can ever see it.

**Use whatever language you like.** Record your intro and write your profile in
the language you're most comfortable in — it doesn't have to match the event's
language. The app writes your matches and summaries in the event's language, and
if your bio is in a different language it shows everyone a translation with your
original one tap away ("show original"). So just be yourself in your own words.

![Recording your intro](images/participant/09-record-light.png)

## 4. See who's here

Once you're in, tap **See who's here** to browse the attendee list. Each row
shows a photo, name, their skills, and — once the matchmaking has run — a match
percentage and a "following" badge if you already follow them on Nostr. You can
re-sort by **matches**, **follows**, or **name**.

![Who's here](images/participant/08-attendees-light.png)

Tap anyone to open their page: their intro video (**▶ Play intro**), what they
do, what they're looking for, an AI-written summary once the matchmaking has
run, and their recent public posts.

On a person's page you can **Follow** them, tap **Message** to start a private
chat (see §6), and — privately, nobody else ever sees these — **★ Favorite**
them, mark **Want to meet** or **Met ✓**, and keep a private note ("the drummer
with the mesh-network startup"). Reload and it all persists.

![A person's page](images/participant/10-attendee-detail-light.png)

## 5. Your matches

Shortly after you record your intro, tap **People you should meet**: a ranked
list of attendees, each with a **match percentage**, a **similar / complementary**
breakdown, and a plain-language explanation of why you two should talk. The
list updates as more people join. Tap a match to open their full page.

![People you should meet](images/participant/11-matches-light.png)

At the event, work the list: find your top matches, mention the app told you to.
Best icebreaker there is.

## 6. Message people

Anyone's page has a **Message** button. Tap it to open a private,
**end-to-end encrypted** conversation:

![A conversation](images/participant/15-dm-chat-light.png)

Your messages live in the **Messages** tab (the 💬 in the bottom bar), which
lists every conversation, newest first:

![Messages inbox](images/participant/14-messages-light.png)

Because these are standard Nostr private messages, **they also work with other
Nostr messengers** — the person can reply from whatever Nostr app they use, and
your conversation shows up there too. It isn't locked to this event.

## 7. Afterwards: your profile is yours to keep

Surprise: the account you just used is a **Nostr identity** — a login you own,
not tied to this app or any company. Open the **Me** tab (👤) to see your
public handle (your *npub*), copy your key, and jump to other Nostr apps.

![Your profile](images/participant/13-me-light.png)

The people you followed at the event, your profile, all of it works across a
whole ecosystem of social apps (Primal, Damus, Amethyst, Yakihonne…). Copy your
key, open one of them, choose "log in with a key", and paste it in — you're
already there.

One more thing: the **Settings** tab (⚙) has a dark mode and a language switch
(English / Slovenčina), and your choice sticks:

![Settings](images/app/settings-light.png)

## Privacy, in one paragraph

Your name, photo, and bio are public (that's your profile). Your intro video,
the attendee list, and your matches are **encrypted so only this event's
approved attendees can see them** — not the public, not people who weren't let
in. Your favorites and private notes are encrypted so **only you** can see
them. Your messages are end-to-end encrypted between you and the other person.
The matching runs on an AI service chosen by the organizer, which reads intros
and profiles to write its recommendations. Here's what a non-attendee sees if
they open the attendee list — nothing:

![What an outsider sees](images/participant/12-outsider-light.png)

## Troubleshooting

- **I'm still "waiting for approval".** Unless you used an invite link, the
  organizer approves people by hand — give it a few minutes, or find them at the
  event. You can safely close the app; check back by reopening the event link.

- **My camera won't start.** Your phone or browser is asking for camera
  permission — look for the prompt (often in the address bar) and allow it. If
  there's no prompt, try another browser.

- **I got a new phone, or cleared my browser.** Open the app, tap **Already on
  Nostr? Sign in → Paste a key**, and paste the secret key you saved when you
  joined. Same account, same events. (This is why saving that key matters.)

- **No matches are showing yet.** Record your intro first — no intro, no
  matches. After that, matches take a little while to compute and need a few
  other people to have joined and recorded too. Check back soon.

- **I don't see the attendee list / videos.** You have to be approved first. If
  you were just approved, reopen the event and give it a moment.
