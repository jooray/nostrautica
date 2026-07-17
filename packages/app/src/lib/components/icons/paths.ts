/**
 * Monochrome nautical icon registry (redesign §3.3). Each value is the inner
 * SVG markup for a 24×24 viewBox; `Icon.svelte` wraps it with the shared
 * stroke spec (currentColor, stroke-width 1.9, round caps/joins). No emoji, no
 * icon font, no network fetch. Fills are only `currentColor` (solid dots) or
 * `currentColor` + `fill-opacity:0.25` (soft accents) — still single-colour.
 *
 * Calendar and clock imagery is banned: event "when" uses the horizon star,
 * live/pinned use the pennant, never a clock or calendar.
 */
export const ICONS = {
  // Event nav
  compass:
    '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" fill-opacity="0.25"/>',
  people:
    '<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 8.5a3 3 0 0 1 0 5"/><path d="M17.5 19a5 5 0 0 0-2.5-4.3"/>',
  constellation:
    '<path d="M5 17l5-5 4 3 5-7"/><circle cx="5" cy="17" r="1.6" fill="currentColor"/><circle cx="10" cy="12" r="1.6" fill="currentColor"/><circle cx="14" cy="15" r="1.6" fill="currentColor"/><circle cx="19" cy="8" r="1.9" fill="currentColor"/>',
  horn: '<path d="M4 11l13-6v14L4 13z"/><path d="M4 11v2a2 2 0 0 0 2 2h1"/><path d="M20 9v6"/>',
  // Talks (F2): a play triangle in a screen — monochrome, no calendar/clock.
  talks:
    '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 8.5l4.5 2.5L10 13.5z" fill="currentColor" fill-opacity="0.25"/><path d="M8 20h8"/>',
  // Global nav + brand
  star: '<path d="M12 3C12.4 9 15 11.6 21 12C15 12.4 12.4 15 12 21C11.6 15 9 12.4 3 12C9 11.6 11.6 9 12 3Z" fill="currentColor" fill-opacity="0.25"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  chat: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-3.5 3v-3H6a2 2 0 0 1-2-2z"/>',
  person: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
  sliders:
    '<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2" fill="currentColor" fill-opacity="0.25"/><path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2" fill="currentColor" fill-opacity="0.25"/><path d="M4 17h9"/><path d="M17 17h3"/><circle cx="15" cy="17" r="2" fill="currentColor" fill-opacity="0.25"/>',
  // Event meta + status
  horizon:
    '<path d="M4 18h16"/><path d="M12 4.5c.3 3 .9 3.6 3.5 4-2.6.4-3.2 1-3.5 4-.3-3-.9-3.6-3.5-4 2.6-.4 3.2-1 3.5-4z" fill="currentColor" fill-opacity="0.25"/>',
  waypoint:
    '<path d="M12 21c4-4.5 6-7.6 6-10.5a6 6 0 0 0-12 0C6 13.4 8 16.5 12 21z"/><circle cx="12" cy="10.5" r="2" fill="currentColor"/>',
  pennant: '<path d="M7 3v18"/><path d="M7 5l11 3.5L7 12z" fill="currentColor" fill-opacity="0.25"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  // Actions + affordances
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  arrowUpRight: '<path d="M8 8h8v8"/><path d="M8 16L16 8"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="M4.3 4.3l1.5 1.5"/><path d="M18.2 18.2l1.5 1.5"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/><path d="M4.3 19.7l1.5-1.5"/><path d="M18.2 5.8l1.5-1.5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  muted: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.5"/>',
  warning:
    '<path d="M12 4.5L21 19a1 1 0 0 1-.9 1.5H3.9A1 1 0 0 1 3 19z"/><path d="M12 10v4"/><path d="M12 17v.5"/>',
  send: '<path d="M21 4L3 11l7 3 3 7z"/><path d="M21 4l-11 10"/>',
} as const;

export type IconName = keyof typeof ICONS;
