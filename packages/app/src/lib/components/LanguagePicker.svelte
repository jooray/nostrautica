<script lang="ts">
  /**
   * Searchable ISO 639-1 language combobox (spec §7.1). The full language list is
   * shared data from @nostrautica/protocol; we display each entry's LOCALIZED name
   * via Intl.DisplayNames in the current UI locale (falling back to the English
   * name), formatted "Slovak (sk)". Typing filters case/diacritic-insensitively
   * against the localized name, the English name, and the code.
   *
   * Ordering: current UI locale → navigator.languages (base codes) → every locale
   * the app itself ships a catalog for (LOCALES), deduped, pinned to the top with a
   * subtle divider; everything else follows alphabetically by displayed name.
   * Keyboard: ↑/↓ move, Enter selects, Esc closes.
   */
  import { tick } from "svelte";
  import { LANGUAGES } from "@nostrautica/protocol";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { LOCALES } from "$lib/i18n/messages.js";

  let {
    value = $bindable("en"),
    id = "lang",
  }: { value?: string; id?: string } = $props();

  interface Option {
    code: string;
    /** Displayed "Localized (code)" label. */
    label: string;
    /** Lowercased, diacritic-stripped haystack for filtering. */
    search: string;
  }

  /** Strip diacritics + lowercase so "slovencina" matches "Slovenčina". */
  function fold(s: string): string {
    return s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  // Localized display name for a code (e.g. "Slovak" in en, "slovenčina" in sk).
  // Falls back to the embedded English name when Intl can't resolve the code.
  const displayName = (() => {
    let dn: Intl.DisplayNames | undefined;
    try {
      dn = new Intl.DisplayNames([i18n.locale], { type: "language" });
    } catch {
      dn = undefined;
    }
    return (code: string, english: string): string => {
      try {
        const n = dn?.of(code);
        if (n && n.toLowerCase() !== code) return n;
      } catch {
        /* unknown code — use the English name */
      }
      return english;
    };
  })();

  // Pinned codes: current locale → navigator.languages base codes → the locales the
  // app ships a UI catalog for. Reading LOCALES rather than repeating the list keeps
  // a newly shipped language pinned without a second edit here.
  const pinnedCodes = $derived.by<string[]>(() => {
    const known = new Set(LANGUAGES.map((l) => l.code));
    const navLangs =
      typeof navigator !== "undefined"
        ? (navigator.languages ?? [navigator.language]).map((l) => l.slice(0, 2).toLowerCase())
        : [];
    const out: string[] = [];
    for (const c of [i18n.locale, ...navLangs, ...LOCALES]) {
      if (known.has(c) && !out.includes(c)) out.push(c);
    }
    return out;
  });

  // Full option list, reactive to the UI locale (so labels re-localize): pinned
  // group first (in pinned order), then everything else alphabetical by label.
  const options = $derived.by<Option[]>(() => {
    const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));
    const opt = (code: string): Option => {
      const info = byCode.get(code)!;
      const shown = displayName(code, info.name);
      return { code, label: `${shown} (${code})`, search: `${fold(shown)} ${fold(info.name)} ${code}` };
    };
    const pinned = pinnedCodes.map(opt);
    const rest = LANGUAGES.filter((l) => !pinnedCodes.includes(l.code))
      .map((l) => opt(l.code))
      .sort((a, b) => a.label.localeCompare(b.label, i18n.locale));
    return [...pinned, ...rest];
  });

  const pinnedCount = $derived(pinnedCodes.length);

  let open = $state(false);
  let query = $state("");
  let active = $state(0); // highlighted index into `filtered`
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  /**
   * The query the highlight-reset effect has already accounted for. The effect
   * below must fire when the user TYPES and not when the list opens — tracking
   * `filtered` fired on both, so openList's "highlight the current language" was
   * overwritten with 0 microseconds later and opening the picker never showed
   * you which language you were already on.
   */
  let resetForQuery = "";

  const selected = $derived(options.find((o) => o.code === value));
  const selectedLabel = $derived(selected?.label ?? value);

  const filtered = $derived.by(() => {
    const q = fold(query.trim());
    if (!q) return options;
    return options.filter((o) => o.search.includes(q));
  });

  function openList() {
    open = true;
    query = "";
    resetForQuery = "";
    active = Math.max(
      0,
      filtered.findIndex((o) => o.code === value),
    );
    scrollActiveIntoView(); // the current language may be far down a 180-item list
    queueMicrotask(() => inputEl?.focus());
  }

  /**
   * Close and hand focus back to the trigger — the same contract the app's modals
   * get from focus-trap.ts. The trigger is destroyed while the picker is open
   * ({#if !open}), so focus was living on the input that just disappeared and the
   * browser dropped it to <body>: a keyboard user's next Tab restarted from the
   * top of the page, and a screen-reader user lost their place entirely.
   * `await tick()` is what makes this work — the button does not exist yet at the
   * moment `open` is set to false.
   *
   * `restoreFocus` is false for the click-outside path only: there the user has
   * already aimed at something else on the page, and yanking focus back to the
   * trigger would fight them for it.
   */
  async function close(restoreFocus = true) {
    open = false;
    query = "";
    resetForQuery = "";
    if (!restoreFocus) return;
    await tick();
    triggerEl?.focus();
  }

  function choose(code: string) {
    value = code;
    void close();
  }

  function scrollActiveIntoView() {
    queueMicrotask(() => {
      const node = listEl?.querySelector<HTMLElement>(`[data-i="${active}"]`);
      node?.scrollIntoView({ block: "nearest" });
    });
  }

  function onKey(e: KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      scrollActiveIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[active];
      if (pick) choose(pick.code);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void close();
    }
  }

  // Reset the highlight to the top when the user CHANGES THE QUERY — not merely
  // when `filtered` is recomputed, which also happens on open (see resetForQuery).
  $effect(() => {
    const q = query;
    if (q === resetForQuery) return;
    resetForQuery = q;
    active = 0;
  });
</script>

<svelte:window
  onpointerdown={(e) => {
    // Close only on an outside pointerdown. Using pointerdown (not click) avoids
    // the race where opening re-renders the trigger away before a click's window
    // handler runs — a detached target would otherwise read as "outside".
    const target = e.target as Node;
    if (open && rootEl && target.isConnected && !rootEl.contains(target)) void close(false);
  }}
/>

<div class="lang" bind:this={rootEl}>
  {#if !open}
    <button
      bind:this={triggerEl}
      type="button"
      {id}
      class="lang-trigger"
      aria-haspopup="listbox"
      aria-expanded="false"
      onclick={openList}
      onkeydown={onKey}
    >
      <span>{selectedLabel}</span>
      <span class="chevron" aria-hidden="true">▾</span>
    </button>
  {:else}
    <input
      bind:this={inputEl}
      bind:value={query}
      class="lang-input"
      role="combobox"
      aria-expanded="true"
      aria-controls="{id}-listbox"
      aria-activedescendant={filtered[active] ? `${id}-opt-${filtered[active].code}` : undefined}
      aria-autocomplete="list"
      autocomplete="off"
      spellcheck="false"
      placeholder={t("lang.searchPlaceholder")}
      aria-label={t("lang.searchPlaceholder")}
      onkeydown={onKey}
    />
    <ul
      bind:this={listEl}
      id="{id}-listbox"
      class="lang-list"
      role="listbox"
      aria-label={t("lang.label")}
    >
      {#if filtered.length === 0}
        <li class="lang-empty">{t("lang.noResults")}</li>
      {/if}
      {#each filtered as o, i (o.code)}
        {#if i === pinnedCount && !query.trim() && pinnedCount > 0 && pinnedCount < filtered.length}
          <li class="lang-divider" role="separator" aria-hidden="true"></li>
        {/if}
        <li
          data-i={i}
          id="{id}-opt-{o.code}"
          role="option"
          aria-selected={o.code === value}
          class="lang-option"
          class:active={i === active}
          onmousedown={(e) => {
            e.preventDefault();
            choose(o.code);
          }}
          onmouseenter={() => (active = i)}
        >
          {o.label}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .lang {
    position: relative;
  }
  .lang-trigger {
    width: 100%;
    min-height: 44px;
    padding: 0.65rem 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .lang-trigger:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
  }
  .lang-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .chevron {
    color: var(--text-dim);
    font-size: 0.8rem;
    flex: none;
  }
  .lang-input {
    width: 100%;
  }
  .lang-list {
    position: absolute;
    z-index: 30;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    max-height: 280px;
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow);
  }
  .lang-option {
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text);
  }
  .lang-option.active,
  .lang-option[aria-selected="true"] {
    background: var(--accent-soft);
  }
  .lang-option[aria-selected="true"] {
    font-weight: 600;
  }
  .lang-divider {
    height: 1px;
    margin: 0.3rem 0.4rem;
    background: var(--border);
  }
  .lang-empty {
    padding: 0.5rem 0.6rem;
    color: var(--text-dim);
  }
</style>
