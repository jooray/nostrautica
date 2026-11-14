/* Mounts the vendored nostr-live widget in #nostr-feed and keeps it in the
   page language. The widget reads the language once when it mounts, and
   app.js changes <html lang> without a reload, so remount on every change. */
(function () {
  "use strict";
  var el = document.getElementById("nostr-feed");
  if (!el || !window.NostrLive) return;
  var RELAYS = ["wss://nostr.cypherpunk.today", "wss://relay.primal.net"];
  var widget = null;
  var lang = null;

  function mount() {
    var next = document.documentElement.getAttribute("lang") || "en";
    if (widget && next === lang) return;
    lang = next;
    if (widget) widget.destroy();
    widget = window.NostrLive.mount(el, {
      nprofile: el.getAttribute("data-nprofile"),
      relays: RELAYS,
      layout: "cards",
      limit: 6,
      lang: lang,
      loadOn: "visible",
      headingLevel: 3
    });
  }

  mount();
  new MutationObserver(mount).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
})();
