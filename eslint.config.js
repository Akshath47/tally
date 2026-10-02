import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig([
  globalIgnores(["dist", ".wrangler", "worker-configuration.d.ts"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Imported bank text is untrusted: render it as text, never as HTML.",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.ts", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
]);
