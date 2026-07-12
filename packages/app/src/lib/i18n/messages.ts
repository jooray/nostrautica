/**
 * Message catalogs (spec §10.5, en + sk initially). Compile-time-static and
 * static-host-friendly — the same property Paraglide JS gives, kept here as a
 * plain typed catalog so there's no runtime message loading. Keys are shared
 * across locales; `en` is the source of truth for the key set.
 */
export const messages = {
  en: {
    "app.tagline": "Meet the right people at events.",
    "nav.login": "Log in",
    "nav.me": "Me",
    "home.title": "Meet the right people",
    "home.getStarted": "Get started",
    "home.createEvent": "Create an event",
    "login.title": "Log in",
    "login.createIdentity": "Create an identity",
    "login.haveKey": "Have a key already?",
    "join.send": "Send join request",
    "join.displayName": "Display name",
    "record.intro": "Record your intro",
    "attendees.title": "Who's here",
    "matches.title": "People you should meet",
    "settings.title": "Settings",
    "settings.theme": "Theme",
    "settings.language": "Language",
    "me.ready": "Your Nostr profile is ready",
    "common.follow": "Follow",
    "common.following": "Following ✓",
    "common.back": "Back",
  },
  sk: {
    "app.tagline": "Stretnite tých správnych ľudí na podujatiach.",
    "nav.login": "Prihlásiť sa",
    "nav.me": "Ja",
    "home.title": "Stretnite tých správnych ľudí",
    "home.getStarted": "Začať",
    "home.createEvent": "Vytvoriť podujatie",
    "login.title": "Prihlásenie",
    "login.createIdentity": "Vytvoriť identitu",
    "login.haveKey": "Už máte kľúč?",
    "join.send": "Odoslať žiadosť o pripojenie",
    "join.displayName": "Zobrazované meno",
    "record.intro": "Nahrajte svoje predstavenie",
    "attendees.title": "Kto je tu",
    "matches.title": "Ľudia, ktorých by ste mali stretnúť",
    "settings.title": "Nastavenia",
    "settings.theme": "Téma",
    "settings.language": "Jazyk",
    "me.ready": "Váš Nostr profil je pripravený",
    "common.follow": "Sledovať",
    "common.following": "Sledované ✓",
    "common.back": "Späť",
  },
} as const;

export type Locale = keyof typeof messages;
export type MessageKey = keyof (typeof messages)["en"];
export const LOCALES: Locale[] = ["en", "sk"];
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", sk: "Slovenčina" };
