// The app's UI strings are the PWA's: packages/app/src/lib/i18n/messages.ts is the
// single source, plus the few native-only strings in app-messages.json. This writes
// one JSON catalog per locale into the app's assets, read by I18n.kt with the same
// fallback, plural and community-variant rules as i18n.svelte.ts.
//   node android/tools/strings/generate.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const { messages, LOCALES, LOCALE_NAMES } = await import(new URL("packages/app/src/lib/i18n/messages.ts", root));
const app = JSON.parse(readFileSync(new URL("android/tools/strings/app-messages.json", root), "utf8"));
const out = new URL("android/app/src/main/assets/i18n/", root);
mkdirSync(out, { recursive: true });

for (const locale of LOCALES) {
  const merged = { ...messages[locale], ...(app[locale] ?? {}) };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  writeFileSync(new URL(`${locale}.json`, out), JSON.stringify(sorted, null, 0) + "\n");
}
writeFileSync(new URL("locales.json", out), JSON.stringify({ locales: LOCALES, names: LOCALE_NAMES }) + "\n");
console.log(`wrote ${LOCALES.length} catalogs (${Object.keys(messages.en).length} web + ${Object.keys(app.en ?? {}).length} app keys)`);
