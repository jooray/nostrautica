// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Project-wide ESLint flat config.
 *
 * The custom `no-restricted-*` rules enforce spec §5.1 / IMPLEMENTATION_PLAN §3.1:
 * NIP-04 is banned project-wide (deprecated, `final unrecommended`). Any nip04 import
 * or `.nip04`/`.encrypt(...,'nip04')` usage is a lint error.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.svelte-kit/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // SvelteKit's app.d.ts declares empty App.* interfaces by design.
      "@typescript-eslint/no-empty-object-type": "off",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "nostr-tools/nip04",
              message: "NIP-04 is banned project-wide (spec §5.1). Use NIP-44.",
            },
            {
              name: "nostr-tools",
              importNames: ["nip04"],
              message: "NIP-04 is banned project-wide (spec §5.1). Use NIP-44.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='nip04']",
          message: "NIP-04 is banned project-wide (spec §5.1). Use 'nip44'.",
        },
        {
          selector: "MemberExpression[property.name='nip04']",
          message: "NIP-04 is banned project-wide (spec §5.1). Use nip44.",
        },
      ],
    },
  },
);
