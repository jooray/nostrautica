/* Nostrautica marketing site — theme toggle + i18n wiring.
   No external requests, no build step. Runs once the DOM this
   script tag is appended after has already been parsed. */
(function () {
  "use strict";

  var LANG_KEY = "nostrautica-lang";
  var THEME_KEY = "nostrautica-theme";
  var LANGS = window.NOSTRAUTICA_LANGS || ["en", "sk", "cs"];
  var DICT = window.NOSTRAUTICA_I18N || {};

  /* ---------- Language ---------- */

  // A language encoded in the URL hash (#en / #sk / #cs, or #cz as an alias),
  // so a link can open the page in a chosen language. Returns null if the hash
  // isn't a language (e.g. an in-page anchor like #attendees).
  function langFromHash() {
    var h = String(location.hash || "").replace(/^#/, "").toLowerCase();
    if (h.indexOf("cz") === 0) h = "cs";
    return LANGS.indexOf(h) !== -1 ? h : null;
  }

  // Precedence: URL hash > stored manual choice > navigator autodetect > en.
  function detectLang() {
    var fromHash = langFromHash();
    if (fromHash) return fromHash;

    try {
      var stored = localStorage.getItem(LANG_KEY);
      if (stored && LANGS.indexOf(stored) !== -1) return stored;
    } catch (e) { /* localStorage unavailable (private mode etc.) */ }

    var prefs = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || "en"];

    for (var i = 0; i < prefs.length; i++) {
      var code = String(prefs[i] || "").toLowerCase();
      if (code.indexOf("sk") === 0) return "sk";
      if (code.indexOf("cs") === 0 || code.indexOf("cz") === 0) return "cs";
      if (code.indexOf("en") === 0) return "en";
    }
    return "en";
  }

  function applyLang(lang) {
    if (LANGS.indexOf(lang) === -1) lang = "en";
    var dict = DICT[lang] || DICT.en;

    document.documentElement.setAttribute("lang", lang);

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) el.textContent = dict[key];
    });

    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-html");
      if (dict[key] !== undefined) el.innerHTML = dict[key];
    });

    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-aria");
      if (dict[key] !== undefined) el.setAttribute("aria-label", dict[key]);
    });

    if (dict["meta.title"]) document.title = dict["meta.title"];
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && dict["meta.description"]) metaDesc.setAttribute("content", dict["meta.description"]);

    document.querySelectorAll(".lang-switch a").forEach(function (btn) {
      var isCurrent = btn.getAttribute("data-lang") === lang;
      btn.setAttribute("aria-current", isCurrent ? "true" : "false");
    });

    // Refresh the theme-toggle aria-label in the now-current language.
    syncThemeButtonLabel();
  }

  // Update the URL hash to reflect the language without scrolling or adding a
  // history entry, so the address bar stays copyable and scroll position holds.
  function reflectLangInHash(lang) {
    try {
      var url = location.pathname + location.search + "#" + lang;
      history.replaceState(history.state, "", url);
    } catch (e) { /* history unavailable — non-fatal */ }
  }

  function setLang(lang, updateHash) {
    if (LANGS.indexOf(lang) === -1) lang = "en";
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
    applyLang(lang);
    if (updateHash) reflectLangInHash(lang);
  }

  /* ---------- Theme ---------- */

  function detectTheme() {
    try {
      var stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch (e) { /* ignore */ }
    // Light is the default; dark only kicks in when the OS explicitly asks for it.
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }

  function currentLang() {
    return document.documentElement.getAttribute("lang") || "en";
  }

  function syncThemeButtonLabel() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    var theme = document.documentElement.getAttribute("data-theme") || detectTheme();
    var dict = DICT[currentLang()] || DICT.en;
    var key = theme === "dark" ? "a11y.toggle_theme_to_light" : "a11y.toggle_theme_to_dark";
    if (dict[key]) btn.setAttribute("aria-label", dict[key]);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    syncThemeButtonLabel();
  }

  function setTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
    applyTheme(theme);
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute("data-theme") || detectTheme();
    setTheme(current === "dark" ? "light" : "dark");
  }

  /* ---------- Wire up ---------- */

  // Theme: applied as early as possible (see inline head script) to avoid
  // a flash; here we just make sure the attribute matches storage/prefs.
  applyTheme(detectTheme());

  applyLang(detectLang());

  // Language switcher: real anchors (href="#en" / "#sk" / "#cs") so right-click →
  // "Copy link address" yields a shareable per-language link. Clicking switches
  // instantly (no reload), persists the choice, and syncs the hash for copying —
  // preventDefault keeps scroll position and avoids a history entry.
  document.querySelectorAll(".lang-switch a").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      setLang(btn.getAttribute("data-lang"), true);
    });
  });

  // If the hash changes to a language (pasted #sk link, manual edit, back/forward),
  // follow it. In-page anchors like #attendees return null and are ignored.
  window.addEventListener("hashchange", function () {
    var fromHash = langFromHash();
    if (fromHash && fromHash !== currentLang()) setLang(fromHash, false);
  });

  /* ---------- Copy shareable link ---------- */

  var copyBtn = document.getElementById("copy-link");
  var copyStatus = document.getElementById("copy-status");
  if (copyBtn) {
    var copyTimer = null;

    function shareUrl() {
      return location.origin + location.pathname + location.search + "#" + currentLang();
    }

    function flashCopied() {
      var dict = DICT[currentLang()] || DICT.en;
      var msg = dict["share.copied"] || "Copied";
      copyBtn.classList.add("copied");
      if (copyStatus) copyStatus.textContent = msg;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(function () {
        copyBtn.classList.remove("copied");
        if (copyStatus) copyStatus.textContent = "";
      }, 1800);
    }

    function legacyCopy(text) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch (e) { return false; }
    }

    copyBtn.addEventListener("click", function () {
      var url = shareUrl();
      // Keep the address bar in sync with what we copy.
      reflectLangInHash(currentLang());
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(flashCopied, function () {
          if (legacyCopy(url)) flashCopied();
        });
      } else if (legacyCopy(url)) {
        flashCopied();
      }
    });
  }

  var themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

  // Keep in sync with OS-level scheme changes, unless the user picked one explicitly.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      var hasExplicitChoice;
      try { hasExplicitChoice = !!localStorage.getItem(THEME_KEY); } catch (e) { hasExplicitChoice = false; }
      if (!hasExplicitChoice) applyTheme(detectTheme());
    });
  }

  // Mobile nav toggle (small screens collapse the link row into a menu).
  var navToggle = document.getElementById("nav-toggle");
  var navLinks = document.getElementById("nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    navLinks.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        navLinks.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Footer year.
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
