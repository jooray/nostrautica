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

  function detectLang() {
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

    document.querySelectorAll(".lang-switch button").forEach(function (btn) {
      var isCurrent = btn.getAttribute("data-lang") === lang;
      btn.setAttribute("aria-current", isCurrent ? "true" : "false");
    });

    // Refresh the theme-toggle aria-label in the now-current language.
    syncThemeButtonLabel();
  }

  function setLang(lang) {
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
    applyLang(lang);
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

  document.querySelectorAll(".lang-switch button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setLang(btn.getAttribute("data-lang"));
    });
  });

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
