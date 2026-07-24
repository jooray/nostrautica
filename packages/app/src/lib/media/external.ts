/**
 * External talk-video URLs (user request 2026-07-24): a talk's video can be a
 * URL the speaker hosts elsewhere — an unlisted YouTube link or a direct mp4 —
 * instead of a Blossom blob, for clips too large for Blossom (>~1 GB). These
 * helpers classify a pasted URL (YouTube vs a direct video file) and build the
 * privacy-friendly `youtube-nocookie` embed URL for playback.
 *
 * The URL itself travels inside the ECK/gift-wrap-encrypted talk content, so it
 * is members-only even though the file it points at is public. Only https is
 * accepted (consistent with the media descriptor's C3 SSRF hardening).
 */
import type { TalkExternalKind } from "@nostrautica/protocol";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/**
 * Parse a URL, returning it only if it's a well-formed https URL. Rejects
 * embedded credentials (audit U10: a `https://user:pass@host/…` talk URL is never
 * a legitimate video and is a phishing/credential-leak shape) — https-only stays
 * consistent with the media descriptor's C3 SSRF hardening.
 */
function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

/** True if `raw` is an https URL on a YouTube host. */
export function isYouTubeUrl(raw: string): boolean {
  const u = httpsUrl(raw);
  return u !== null && YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
}

/**
 * Extract the 11-char YouTube video id from any common YouTube URL shape:
 * `watch?v=ID`, `youtu.be/ID`, `/embed/ID`, `/shorts/ID`, `/live/ID`.
 * Returns null if it isn't a recognizable YouTube video URL.
 */
export function youTubeId(raw: string): string | null {
  const u = httpsUrl(raw);
  if (!u || !YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return null;
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    id = u.pathname.split("/").filter(Boolean)[0] ?? null;
  } else {
    const v = u.searchParams.get("v");
    if (v) {
      id = v;
    } else {
      const parts = u.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((p) => p === "embed" || p === "shorts" || p === "live");
      if (marker >= 0) id = parts[marker + 1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** The privacy-friendly embed URL for a YouTube video id (no-cookie host). */
export function youTubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

/**
 * The referrer policy for an external talk source (audit U10 vs YouTube Error 153).
 *
 * A direct `<video>` sends NO referrer — nothing about the video needs it, and a
 * stripped referrer is the most private choice. A YouTube embed is the exception:
 * its player refuses to start with a stripped referrer and shows Error 153 ("Video
 * player configuration error"), so it MUST send `origin` — only the scheme+host,
 * never the full (hash-routed) URL, so it stays privacy-preserving while passing
 * the embed's referrer check. Keeping this a pure function makes the invariant
 * ("YouTube ≠ no-referrer") testable without rendering the player.
 */
export function externalReferrerPolicy(kind: TalkExternalKind): "origin" | "no-referrer" {
  return kind === "youtube" ? "origin" : "no-referrer";
}

/**
 * The host a talk URL will contact, for the pre-load privacy gate (audit U10) —
 * so the viewer sees WHO playback reaches before any third-party request fires.
 * Returns null for an unusable URL.
 */
export function talkUrlHost(raw: string): string | null {
  return httpsUrl(raw)?.host ?? null;
}

/**
 * Classify a pasted talk URL. Returns the normalized https URL and whether it's
 * a YouTube link (played via an embed) or a direct video file (a plain
 * `<video>`), or null if the input isn't a usable https URL. A YouTube host that
 * doesn't resolve to a video id is rejected (null) rather than treated as a raw
 * video file — an embed needs the id.
 */
export function classifyTalkUrl(raw: string): { kind: TalkExternalKind; url: string } | null {
  const u = httpsUrl(raw);
  if (!u) return null;
  if (YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) {
    return youTubeId(raw) ? { kind: "youtube", url: u.toString() } : null;
  }
  return { kind: "video", url: u.toString() };
}
